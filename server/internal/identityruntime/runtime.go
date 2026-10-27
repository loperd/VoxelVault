// Package identityruntime composes Identity ports, shared Security policies and
// owned account storage. No bounded context imports this composition root.
package identityruntime

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/voxel-vault/api/internal/identity/adapters/authorization"
	"github.com/voxel-vault/api/internal/identity/adapters/inbound/local"

	"github.com/voxel-vault/api/internal/identity/adapters/postgres"
	"github.com/voxel-vault/api/internal/identity/application"
	v1 "github.com/voxel-vault/api/internal/identity/contracts/v1"
	"github.com/voxel-vault/api/internal/identity/domain"
	"github.com/voxel-vault/api/internal/security/adapters/policyconfig"
	security "github.com/voxel-vault/api/internal/security/application"
	sv1 "github.com/voxel-vault/api/internal/security/contracts/v1"
)

type Runtime struct {
	Sessions       v1.Sessions
	Accounts       v1.Accounts
	Profiles       v1.Profiles
	Recipient      v1.RecipientResolver
	Security       sv1.Subjects
	SecurityDB     *sql.DB
	DB             *sql.DB
	registration   *application.Accounts
	sessionService application.Service
	gateway        string
	checks         []func(context.Context) error
	closers        []func() error
}

func (r *Runtime) Close() {
	for _, close := range r.closers {
		_ = close()
	}
	_ = r.DB.Close()
}
func (r *Runtime) Ready(ctx context.Context) error {
	var version int64
	err := r.DB.QueryRowContext(ctx, `SELECT max(version_id) FROM public.identity_schema_version WHERE is_applied`).Scan(&version)
	if err != nil {
		return err
	}
	if version != 3 {
		return fmt.Errorf("Identity schema version must be 3")
	}
	for _, check := range r.checks {
		if err := check(ctx); err != nil {
			return err
		}
	}
	return nil
}
func Authorizer(gateway string) (application.Authorizer, error) {
	if !domain.ValidID(gateway) {
		return nil, domain.ErrInvalid
	}
	var rules []security.Rule
	for permission, kind := range map[string]string{"identity.session.issue": "account", "identity.session.refresh": "session", "identity.session.revoke": "session", "identity.session.validate": "session"} {
		rules = append(rules, security.Rule{Context: "identity", Role: "session-gateway", ActorKind: "service", Permission: permission, ResourceKind: kind, Scope: security.OwnerScope, Sources: []string{gateway}})
	}
	client, err := policyconfig.New(policyconfig.Policy{Version: "identity-session-rbac-v1", Bindings: []policyconfig.Binding{{Kind: "service", ID: gateway, Roles: []string{"session-gateway"}}}, Rules: rules}, nil)
	if err != nil {
		return nil, err
	}
	return authorization.Security{Client: client}, nil
}
func Open(ctx context.Context, dsn string, gateway string) (*Runtime, error) {
	if dsn == "" {
		return nil, fmt.Errorf("Identity connection is required")
	}
	auth, err := Authorizer(gateway)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("invalid Identity connection")
	}
	r := &Runtime{DB: db}
	if err = r.Ready(ctx); err != nil {
		r.Close()
		return nil, fmt.Errorf("Identity schema is unavailable or not migrated: %w", err)
	}
	service := application.Service{Store: postgres.Store{DB: db}, Directory: postgres.Store{DB: db}, Authorizer: auth, Clock: time.Now, ID: func() (string, error) {
		b := make([]byte, 16)
		_, err := rand.Read(b)
		return hex.EncodeToString(b), err
	}, Token: func() (string, error) {
		b := make([]byte, 32)
		_, err := rand.Read(b)
		return base64.RawURLEncoding.EncodeToString(b), err
	}}
	r.Sessions = local.Sessions{Service: service, Principal: application.Principal{Kind: "service", ID: gateway}}
	r.sessionService = service
	r.gateway = gateway
	return r, nil
}
