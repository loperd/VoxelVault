package gatewayhttp

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	v1 "github.com/voxel-vault/api/identity/contracts/v1"
	peer "github.com/voxel-vault/api/platform/gatewayhttp"
)

type Handler struct {
	client   v1.Sessions
	accounts v1.Accounts
	peer     *peer.Peer
	mux      *http.ServeMux
}

func New(client v1.Sessions, token string, accounts ...v1.Accounts) (http.Handler, error) {
	if client == nil {
		return nil, errors.New("identity sessions client is required")
	}
	trusted, err := peer.New(token)
	if err != nil {
		return nil, err
	}
	h := &Handler{client: client, peer: trusted, mux: http.NewServeMux()}
	if len(accounts) > 1 {
		return nil, errors.New("one accounts client is required")
	}
	if len(accounts) == 1 && accounts[0] != nil {
		h.accounts = accounts[0]
		h.accountRoutes()
	}
	h.mux.HandleFunc("POST /internal/sessions/issue", h.issue)
	h.mux.HandleFunc("POST /internal/sessions/refresh", h.refresh)
	h.mux.HandleFunc("POST /internal/sessions/revoke", h.revoke)
	h.mux.HandleFunc("POST /internal/sessions/validate", h.validate)
	return h, nil
}
func (h *Handler) validate(w http.ResponseWriter, r *http.Request) {
	var b struct {
		SessionID string `json:"sessionId"`
		UserID    string `json:"userId"`
	}
	if !decode(w, r, &b) {
		return
	}
	if err := h.client.Validate(r.Context(), b.SessionID, b.UserID); err != nil {
		failure(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !h.peer.Trusted(r) {
		respond(w, 401, map[string]string{"error": "unauthenticated"})
		return
	}
	h.mux.ServeHTTP(w, r)
}
func decode(w http.ResponseWriter, r *http.Request, target any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		respond(w, 400, map[string]string{"error": "invalid request"})
		return false
	}
	if d.Decode(new(any)) != io.EOF {
		respond(w, 400, map[string]string{"error": "invalid request"})
		return false
	}
	return true
}
func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func failure(w http.ResponseWriter, err error) {
	status := 503
	var f *v1.Error
	if errors.As(err, &f) {
		switch f.Code {
		case "invalid":
			status = 400
		case "forbidden":
			status = 403
		case "unauthenticated":
			status = 401
		case "conflict":
			status = 409
		}
	}
	respond(w, status, map[string]string{"error": "identity request rejected"})
}
func (h *Handler) issue(w http.ResponseWriter, r *http.Request) {
	var b struct {
		UserID     string `json:"userId"`
		TTLSeconds int64  `json:"ttlSeconds"`
		UserAgent  string `json:"userAgent"`
		IP         string `json:"ip"`
	}
	if !decode(w, r, &b) {
		return
	}
	v, err := h.client.Issue(r.Context(), v1.Issue{UserID: b.UserID, TTLSeconds: b.TTLSeconds, UserAgent: b.UserAgent, IP: b.IP})
	if err != nil {
		failure(w, err)
		return
	}
	respond(w, 201, map[string]string{"sessionId": v.SessionID, "refreshJti": v.RefreshJTI})
}
func (h *Handler) refresh(w http.ResponseWriter, r *http.Request) {
	var b struct {
		SessionID  string `json:"sessionId"`
		RefreshJTI string `json:"refreshJti"`
	}
	if !decode(w, r, &b) {
		return
	}
	v, err := h.client.Refresh(r.Context(), b.SessionID, b.RefreshJTI)
	if err != nil {
		failure(w, err)
		return
	}
	respond(w, 200, map[string]string{"userId": v.UserID, "refreshJti": v.RefreshJTI})
}
func (h *Handler) revoke(w http.ResponseWriter, r *http.Request) {
	var b struct {
		SessionID string `json:"sessionId"`
	}
	if !decode(w, r, &b) {
		return
	}
	if err := h.client.Revoke(r.Context(), b.SessionID); err != nil {
		failure(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
