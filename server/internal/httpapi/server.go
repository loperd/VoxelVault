package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/voxel-vault/api/internal/config"
	iv1 "github.com/voxel-vault/api/inventory/contracts/v1"
	"github.com/voxel-vault/api/inventory/domain/rulebook"
	"gorm.io/gorm"
)

type contextKey string

const userContextKey contextKey = "user"

type Server struct {
	db           *gorm.DB
	config       config.Config
	identity     *IdentityPorts
	mux          *http.ServeMux
	rulebook     func() *rulebook.Rulebook
	starter      []iv1.Grant
	contexts     *ContextPorts
	economyGuard func(context.Context) error
	limits       limiter
}

// New serves the API; rb is the chest economy's rulebook in force. It receives only published
// context ports. The composition root owns all database wiring and supplies a guard that fails
// closed during migration/outages.
func New(db *gorm.DB, cfg config.Config, identity *IdentityPorts, rb *rulebook.Rulebook, ports *ContextPorts, guard func(context.Context) error) (*Server, error) {
	if ports == nil || ports.Collection == nil || ports.Workshop == nil || ports.Wallet == nil || ports.Transfer == nil || ports.Currency == nil || ports.Subjects == nil || ports.UserContext == nil || guard == nil ||
		ports.RecipientPerMinute < 1 || ports.QuotePerMinute < 1 || ports.TransferPerMinute < 1 {
		return nil, fmt.Errorf("complete context ports and readiness guard are required")
	}
	if identity == nil || identity.Profiles == nil || identity.Sessions == nil || identity.Security == nil || identity.Peer == nil {
		return nil, fmt.Errorf("complete gateway Identity and Security ports are required")
	}
	starter, err := parseGrants(rb, cfg.StarterChests)
	if err != nil {
		return nil, fmt.Errorf("configure starter chests: %w", err)
	}
	current := func() *rulebook.Rulebook { return rb }
	s := &Server{db: db, config: cfg, identity: identity, mux: http.NewServeMux(), rulebook: current, starter: starter, contexts: ports, economyGuard: guard}
	s.routes()
	return s, nil
}

func (s *Server) Handler() http.Handler {
	return securityHeaders(s.mux)
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	s.mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		sqlDB, err := s.db.DB()
		if err == nil {
			err = sqlDB.PingContext(r.Context())
		}
		if err == nil {
			err = s.economyGuard(r.Context())
		}
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "database unavailable")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})
	s.mux.HandleFunc("GET /api/v1/cases", s.listCases)
	s.mux.HandleFunc("GET /api/v1/cases/{caseID}/catalog", s.caseCatalog)
	s.mux.HandleFunc("GET /api/v1/items/{itemID}/image.svg", s.itemImage)
	s.mux.HandleFunc("GET /api/v1/me", s.requirePermission("/api/v1/me", "GET", s.me))
	s.mux.HandleFunc("POST /api/v1/access/users/{userID}/roles", s.sameOrigin(s.requireUser(s.assignRole)))
	s.contextRoutes()
}

type itemDTO struct {
	ID     string  `json:"id"`
	Title  string  `json:"title"`
	Image  string  `json:"image"`
	Type   string  `json:"type"`
	Chance float64 `json:"chance"`
}

type caseDTO struct {
	ID         string `json:"id"`
	Collection string `json:"collection"`
}

func (s *Server) listCases(w http.ResponseWriter, r *http.Request) {
	types := s.rulebook().Types()
	cases := make([]caseDTO, 0, len(types))
	for _, t := range types {
		cases = append(cases, caseDTO{ID: t.ID, Collection: t.Collection})
	}
	writeJSON(w, http.StatusOK, cases)
}

// caseCatalog is everything a chest type can hold, by the rulebook; chance is the pool weight
// as a percentage of the pool.
func (s *Server) caseCatalog(w http.ResponseWriter, r *http.Request) {
	rb := s.rulebook()
	chestType, ok := rb.Type(r.PathValue("caseID"))
	if !ok {
		writeError(w, 404, "chest type not found")
		return
	}
	weights := make([]float64, len(chestType.Pool))
	var total float64
	for i, item := range chestType.Pool {
		weights[i] = rb.Value("pool.weight."+item.Rarity, rulebook.Situation{"type": chestType.ID, "collection": chestType.Collection, "item.rarity": item.Rarity})
		total += weights[i]
	}
	dtos := make([]itemDTO, 0, len(chestType.Pool))
	for i, item := range chestType.Pool {
		dtos = append(dtos, rulebookItemDTO(rb, item.ID, percent(weights[i], total)))
	}
	writeJSON(w, http.StatusOK, dtos)
}

// Item art belongs to the object itself; character portraits are not item icons.
func itemImageURL(id, _ string) string {
	return "/api/v1/items/" + id + "/image.svg?v=2"
}

func (s *Server) itemImage(w http.ResponseWriter, r *http.Request) {
	// The rulebook is the item catalogue.
	item, _, ok := s.rulebook().Item(r.PathValue("itemID"))
	if !ok {
		writeError(w, 404, "item image not found")
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, itemSVG(item))
}

func (s *Server) requireUser(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, err := s.gatewayUser(r)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		ctx := s.contexts.UserContext(context.WithValue(r.Context(), userContextKey, user), user.ID)
		next(w, r.WithContext(ctx))
	}
}

func (s *Server) requirePermission(object, action string, next http.HandlerFunc) http.HandlerFunc {
	return s.requireUser(func(w http.ResponseWriter, r *http.Request) {
		user := userFrom(r.Context())
		allowed, err := s.identity.Allowed(r.Context(), r, user.ID, action)
		if err != nil {
			writeError(w, 500, "authorization check failed")
			return
		}
		if !allowed {
			writeError(w, 403, "permission denied")
			return
		}
		next(w, r)
	})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r.Context())
	roles, err := s.identity.Security.Roles(r.Context(), user.ID)
	if err != nil {
		writeError(w, 503, "authorization unavailable")
		return
	}
	writeJSON(w, 200, map[string]any{"id": user.ID, "handle": user.Handle, "displayName": user.DisplayName, "roles": roles})
}

func (s *Server) assignRole(w http.ResponseWriter, r *http.Request) {
	caller := userFrom(r.Context())
	var body struct {
		Role string `json:"role"`
	}
	if !decode(w, r, &body) {
		writeError(w, 400, "invalid role")
		return
	}
	allowed, err := s.identity.Allowed(r.Context(), r, caller.ID, "POST")
	if err != nil || !allowed {
		writeError(w, 403, "permission denied")
		return
	}
	target := r.PathValue("userID")
	exists, err := s.identity.Profiles.Exists(r.Context(), target)
	if err != nil {
		writeError(w, 503, "identity unavailable")
		return
	}
	if !exists {
		writeError(w, 404, "user not found")
		return
	}
	err = s.identity.Security.Assign(r.Context(), caller.ID, target, body.Role)
	if err != nil {
		writeError(w, 403, "permission denied")
		return
	}
	roles, err := s.identity.Security.Roles(r.Context(), target)
	if err != nil {
		writeError(w, 503, "authorization unavailable")
		return
	}
	writeJSON(w, 200, map[string]any{"userId": target, "roles": roles})
}
func userFrom(ctx context.Context) User { return ctx.Value(userContextKey).(User) }

func decode(w http.ResponseWriter, r *http.Request, value any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(value); err != nil {
		return false
	}
	return decoder.Decode(&struct{}{}) == io.EOF
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}
