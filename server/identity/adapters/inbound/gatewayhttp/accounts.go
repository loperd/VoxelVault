package gatewayhttp

import (
	v1 "github.com/voxel-vault/api/identity/contracts/v1"
	"net/http"
)

func (h *Handler) accountRoutes() {
	h.mux.HandleFunc("POST /internal/auth/resolve", h.resolve)
	h.mux.HandleFunc("POST /internal/auth/link", h.link)
	h.mux.HandleFunc("POST /internal/auth/permissions", h.permissions)
	h.mux.HandleFunc("POST /internal/auth/memberships", h.memberships)
	h.mux.HandleFunc("GET /internal/auth/scopes", h.catalog)
}
func (h *Handler) resolve(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Provider    string `json:"provider"`
		ExternalID  string `json:"externalId"`
		Username    string `json:"username"`
		DisplayName string `json:"displayName"`
	}
	if !decode(w, r, &b) {
		return
	}
	id, err := h.accounts.Resolve(r.Context(), v1.ProviderIdentity{Provider: b.Provider, ExternalID: b.ExternalID, Username: b.Username, DisplayName: b.DisplayName})
	if err != nil {
		failure(w, err)
		return
	}
	respond(w, 200, map[string]any{"userId": id, "memberships": []any{}})
}
func (h *Handler) link(w http.ResponseWriter, r *http.Request) {
	var b struct {
		SessionID  string   `json:"sessionId"`
		Scopes     []string `json:"scopes"`
		UserID     string   `json:"userId"`
		Provider   string   `json:"provider"`
		ExternalID string   `json:"externalId"`
		Username   string   `json:"username"`
	}
	if !decode(w, r, &b) {
		return
	}
	conflict, err := h.accounts.Link(r.Context(), v1.LinkRequest{UserID: b.UserID, SessionID: b.SessionID, Scopes: b.Scopes, Identity: v1.ProviderIdentity{Provider: b.Provider, ExternalID: b.ExternalID, Username: b.Username}})
	if err != nil {
		failure(w, err)
		return
	}
	respond(w, 200, map[string]any{"ok": conflict == "", "conflictUserId": conflict})
}
func (h *Handler) permissions(w http.ResponseWriter, r *http.Request) {
	var b struct {
		UserID string `json:"userId"`
	}
	if !decode(w, r, &b) {
		return
	}
	scopes, err := h.accounts.Permissions(r.Context(), b.UserID)
	if err != nil {
		failure(w, err)
		return
	}
	respond(w, 200, map[string]any{"userId": b.UserID, "scopes": scopes})
}
func (h *Handler) memberships(w http.ResponseWriter, r *http.Request) {
	var b struct {
		UserID string `json:"userId"`
	}
	if !decode(w, r, &b) {
		return
	}
	if _, err := h.accounts.Permissions(r.Context(), b.UserID); err != nil {
		failure(w, err)
		return
	}
	respond(w, 200, map[string]any{"memberships": []any{}})
}
func (h *Handler) catalog(w http.ResponseWriter, r *http.Request) {
	scopes, err := h.accounts.Catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	respond(w, 200, map[string]any{"scopes": scopes})
}
