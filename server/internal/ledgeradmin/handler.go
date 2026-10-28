// Package ledgeradmin serves the internal endpoint behind `ledgerctl`. It has no login: every
// call carries an Ed25519 signature by a registered key, and a request runs only with three.
package ledgeradmin

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/voxel-vault/api/ledger/application"
	"github.com/voxel-vault/api/ledger/domain"
)

type Store interface {
	AdminCreate(ctx context.Context, keyID, action, payload string, sig []byte) (string, error)
	AdminSign(ctx context.Context, id, keyID string, sig []byte) error
	AdminExecute(ctx context.Context, id string, at time.Time) error
	AdminRequest(ctx context.Context, id string) (action, payload string, signers []string, executed bool, err error)
}

type body struct {
	KeyID     string `json:"key_id"`
	Action    string `json:"action"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"` // hex
}

func New(store Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/ledger-admin/requests", handle(func(r *http.Request, b body, sig []byte) (any, error) {
		id, err := store.AdminCreate(r.Context(), b.KeyID, b.Action, b.Payload, sig)
		return map[string]string{"id": id}, err
	}))
	mux.HandleFunc("POST /internal/ledger-admin/requests/{id}/signatures", handle(func(r *http.Request, b body, sig []byte) (any, error) {
		return map[string]string{"status": "signed"}, store.AdminSign(r.Context(), r.PathValue("id"), b.KeyID, sig)
	}))
	mux.HandleFunc("GET /internal/ledger-admin/requests/{id}", handle(func(r *http.Request, _ body, _ []byte) (any, error) {
		action, payload, signers, executed, err := store.AdminRequest(r.Context(), r.PathValue("id"))
		return map[string]any{"action": action, "payload": payload, "signers": signers, "executed": executed}, err
	}))
	mux.HandleFunc("POST /internal/ledger-admin/requests/{id}/execute", handle(func(r *http.Request, _ body, _ []byte) (any, error) {
		return map[string]string{"status": "executed"}, store.AdminExecute(r.Context(), r.PathValue("id"), time.Now().UTC())
	}))
	return mux
}

func handle(fn func(*http.Request, body, []byte) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if r.Method == http.MethodPost && r.ContentLength != 0 && json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&b) != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		sig, _ := hex.DecodeString(b.Signature)
		out, err := fn(r, b, sig)
		switch {
		case err == nil:
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(out)
		case errors.Is(err, application.ErrForbidden):
			http.Error(w, "forbidden", http.StatusForbidden)
		case errors.Is(err, domain.ErrInvalid):
			http.Error(w, "invalid request", http.StatusBadRequest)
		case errors.Is(err, domain.ErrConflict), errors.Is(err, application.ErrTransferFunds):
			http.Error(w, err.Error(), http.StatusConflict)
		default:
			http.Error(w, "internal error", http.StatusInternalServerError)
		}
	}
}
