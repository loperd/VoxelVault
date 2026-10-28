package httpapi

import (
	"context"
	"database/sql"
	"github.com/voxel-vault/api/internal/securityruntime"
	"os"
	"strings"
	"testing"

	imigrate "github.com/voxel-vault/api/identity/adapters/postgres/migrations"
	iv1 "github.com/voxel-vault/api/identity/contracts/v1"
	"github.com/voxel-vault/api/internal/identityruntime"
	"github.com/voxel-vault/api/platform/gatewayhttp"
	smigrate "github.com/voxel-vault/api/security/adapters/postgres/migrations"
)

const fixtureToken = "trusted-http-fixture-peer-credential"

type fixtureACL struct{ DB *sql.DB }

func (f *fixtureACL) AddGroupingPolicy(subject, role string) (bool, error) {
	r, e := f.DB.Exec(`INSERT INTO security.role_bindings(subject,role) VALUES($1,$2) ON CONFLICT DO NOTHING`, subject, role)
	if e != nil {
		return false, e
	}
	n, e := r.RowsAffected()
	return n == 1, e
}
func (f *httpContexts) setupIdentity(t *testing.T, dsn string) {
	t.Helper()
	ctx := context.Background()
	if e := smigrate.Up(ctx, f.source); e != nil {
		t.Fatal(e)
	}
	if e := imigrate.Up(ctx, f.source); e != nil {
		t.Fatal(e)
	}
	policy, e := os.ReadFile("../../config/security.json")
	if e != nil {
		t.Fatal(e)
	}
	if e = securityruntime.SeedPolicy(ctx, f.source, policy); e != nil {
		t.Fatal(e)
	}
	rt, e := identityruntime.Open(ctx, dsn, "project-gateway")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(rt.Close)
	if e = rt.EnableAccounts(ctx, dsn, "player", []string{"telegram"}); e != nil {
		t.Fatal(e)
	}
	f.sessions = map[string]string{}
	for _, id := range []string{"alice", "bob"} {
		httpExec(t, f.source, `INSERT INTO identity.accounts(id,handle,display_name,created_at,updated_at)VALUES($1,$1,$1,now(),now())`, id)
		httpExec(t, f.source, `INSERT INTO security.role_bindings(subject,role)VALUES($1,'player')`, id)
		session, e := rt.Sessions.Issue(ctx, iv1.Issue{UserID: id, TTLSeconds: 3600})
		if e != nil {
			t.Fatal(e)
		}
		f.sessions[id] = session.SessionID
	}
	peer, e := gatewayhttp.New(fixtureToken)
	if e != nil {
		t.Fatal(e)
	}
	f.identity = &IdentityPorts{Peer: peer, Profiles: rt.Profiles, Sessions: rt.Sessions, Security: rt.Security}
	f.acl = &fixtureACL{DB: f.source}
}
func fixtureScopes(f *httpContexts, id string) string {
	// Token grants remain the original grant even if the current role is revoked.
	// Production intersects these claims with fresh role decisions.
	permissions, e := f.identity.Security.Catalog(context.Background())
	if e != nil {
		return ""
	}
	var out []string
	for _, p := range permissions {
		out = append(out, p.Action+":"+p.Resource)
	}
	return strings.Join(out, ",")
}
