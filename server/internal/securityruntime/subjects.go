// Package securityruntime composes Security-owned persistence and generic policy
// configuration. Consumers receive only published Security contracts.
package securityruntime

import (
	"context"
	"database/sql"
	"fmt"

	"strings"
	"time"

	"github.com/voxel-vault/api/security/adapters/inbound/local"
	"github.com/voxel-vault/api/security/adapters/policyconfig"
	"github.com/voxel-vault/api/security/adapters/postgres"
	"github.com/voxel-vault/api/security/application"
	v1 "github.com/voxel-vault/api/security/contracts/v1"
)

type Runtime struct {
	Subjects v1.Subjects
	DB       *sql.DB
}

func (r *Runtime) Close() { _ = r.DB.Close() }
func (r *Runtime) Ready(ctx context.Context) error {
	var version int64

	err := r.DB.QueryRowContext(ctx, `SELECT max(version_id) FROM public.security_schema_version WHERE is_applied`).Scan(&version)
	if err != nil {
		return err
	}
	if version != 2 {
		return fmt.Errorf("Security registration schema or policy storage is unavailable")
	}
	return nil
}
func New(db *sql.DB, actor, role string, spec application.RolePolicySpec) (v1.Subjects, error) {
	if db == nil || actor == "" || role == "" || len(actor) > 160 || len(role) > 80 || strings.TrimSpace(actor) != actor || strings.TrimSpace(role) != role || strings.ContainsAny(actor+role, "\x00\r\n") {
		return nil, application.ErrInvalid
	}
	policy, err := application.NewRolePolicy(spec)
	if err != nil || !policy.HasRole(role) {
		return nil, application.ErrInvalid
	}
	var rules []application.Rule
	for _, permission := range []string{"security.roles.assign", "security.subject.register", "security.permissions.read", "security.permissions.catalog", "security.permissions.check"} {
		rules = append(rules, application.Rule{Context: "security", Role: "identity-registrar", ActorKind: "service", Permission: permission, ResourceKind: "subject", Scope: application.OwnerScope, Sources: []string{actor}})
	}
	client, err := policyconfig.New(policyconfig.Policy{Version: "security-registration-rbac-v1", Bindings: []policyconfig.Binding{{Kind: "service", ID: actor, Roles: []string{"identity-registrar"}}}, Rules: rules}, nil)
	if err != nil {
		return nil, err
	}
	// The shared client supplies public DTOs. The local adapter performs the
	// translation back into Security's own application request type.
	authorizer := decisionAdapter{Client: client}
	return local.Subjects{Service: application.SubjectService{Store: postgres.Subjects{DB: db}, Authorizer: authorizer, DefaultRole: role, Clock: time.Now, Policy: policy}, Actor: application.Actor{Kind: "service", ID: actor}}, nil
}

type decisionAdapter struct{ Client v1.Client }

func (a decisionAdapter) Decide(ctx context.Context, r application.Request) (application.Decision, error) {
	d, err := a.Client.Decide(ctx, v1.Request{Context: r.Context, ActorKind: r.Actor.Kind, ActorID: r.Actor.ID, Permission: r.Permission, ResourceKind: r.ResourceKind, ResourceID: r.ResourceID, Owner: r.Owner, Source: r.Source})
	return application.Decision{Allowed: d.Allowed, PolicyVersion: d.PolicyVersion}, err
}
func Open(ctx context.Context, dsn, actor, role string, spec application.RolePolicySpec) (*Runtime, error) {
	if dsn == "" {
		return nil, fmt.Errorf("SECURITY_DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	r := &Runtime{DB: db}
	if err = r.Ready(ctx); err != nil {
		r.Close()
		return nil, err
	}
	r.Subjects, err = New(db, actor, role, spec)
	if err != nil {
		r.Close()
		return nil, err
	}
	return r, nil
}
