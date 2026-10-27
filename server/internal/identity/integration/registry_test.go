package integration_test

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"github.com/voxel-vault/api/internal/identity/adapters/postgres"
	"github.com/voxel-vault/api/internal/identity/adapters/postgres/migrations"
	"github.com/voxel-vault/api/internal/platform/resourcegrants"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	roles "github.com/voxel-vault/api/internal/identity/adapters/security"
	"github.com/voxel-vault/api/internal/identity/application"
	"github.com/voxel-vault/api/internal/identity/domain"
	"github.com/voxel-vault/api/internal/identityruntime"
	"github.com/voxel-vault/api/internal/platform/postgrespermissions"
	"github.com/voxel-vault/api/internal/platform/testpostgres"
	securitypg "github.com/voxel-vault/api/internal/security/adapters/postgres"
	securitymigrations "github.com/voxel-vault/api/internal/security/adapters/postgres/migrations"
	securityapp "github.com/voxel-vault/api/internal/security/application"
	securityv1 "github.com/voxel-vault/api/internal/security/contracts/v1"
	"github.com/voxel-vault/api/internal/securityruntime"
)

var ctx = application.WithAuthenticatedPrincipal(context.Background(), application.Principal{Kind: "service", ID: "gateway"})

func newID() (string, error) {
	b := make([]byte, 16)
	_, err := rand.Read(b)
	return hex.EncodeToString(b), err
}

type conflictRoles struct{ application.Roles }

func (conflictRoles) Register(context.Context, string, string) (application.RoleReceipt, error) {
	return application.RoleReceipt{}, application.ErrConflict
}
func TestPermanentRegistrationConflictIsTrackedAndNotRetried(t *testing.T) {
	f := setup(t)
	f.service.Roles = conflictRoles{f.service.Roles}
	if _, err := f.service.Resolve(ctx, provider("conflicted")); !errors.Is(err, application.ErrConflict) {
		t.Fatal(err)
	}
	if count(t, f.accounts, `SELECT count(*) FROM identity.registrations WHERE state='reconciliation' AND last_error='conflict' AND attempts=1`) != 1 {
		t.Fatal("conflict not tracked")
	}
	f.service.Clock = func() time.Time { return time.Now().Add(time.Hour) }
	worker := application.WithAuthenticatedPrincipal(context.Background(), application.Principal{Kind: "service", ID: identityruntime.RegistrationWorker})
	if n, err := f.service.ResumePending(worker, 64); err != nil || n != 0 {
		t.Fatal("permanent conflict was retried", n, err)
	}
	if _, err := f.service.Resolve(ctx, provider("conflicted")); !errors.Is(err, application.ErrConflict) {
		t.Fatal(err)
	}
	if count(t, f.accounts, `SELECT count(*) FROM identity.accounts`) != 1 || count(t, f.security, `SELECT count(*) FROM security.subject_registrations`) != 0 {
		t.Fatal("conflict created another user or grant")
	}
}
func TestUsernameDoesNotProveOwnershipOfExistingAccount(t *testing.T) {
	f := setup(t)
	existing, err := f.service.Resolve(ctx, provider("old"))
	if err != nil {
		t.Fatal(err)
	}
	p := provider("different-subject")
	if err := f.accounts.QueryRow(`SELECT handle,display_name FROM identity.accounts WHERE id=$1`, existing).Scan(&p.Username, &p.DisplayName); err != nil {
		t.Fatal(err)
	}
	id, err := f.service.Resolve(ctx, p)
	if err != nil || id == existing {
		t.Fatal("profile hints claimed an existing account", id, err)
	}
}
func TestSecurityReceiptConflictsNeverGrantAnotherSubject(t *testing.T) {
	f := setup(t)
	client, err := securityruntime.New(f.security, "identity-registrar", "player", testPolicy())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.Register(context.Background(), securityv1.SubjectRegistration{CommandID: "command", Subject: "subject-a"}); err != nil {
		t.Fatal(err)
	}
	for _, r := range []securityv1.SubjectRegistration{{CommandID: "different", Subject: "subject-a"}, {CommandID: "command", Subject: "subject-b"}} {
		_, err = client.Register(context.Background(), r)
		var failure *securityv1.SubjectError
		if !errors.As(err, &failure) || failure.Code != "conflict" {
			t.Fatal(err)
		}
	}
	if count(t, f.security, `SELECT count(*) FROM security.subject_registrations`) != 1 || count(t, f.security, `SELECT count(*) FROM security.role_bindings WHERE true`) != 1 {
		t.Fatal("conflicting registration leaked a grant")
	}
}
func TestRegistryAndSecuritySchemasHaveNoCustomDatabaseCode(t *testing.T) {
	f := setup(t)
	for _, db := range []*sql.DB{f.accounts, f.security} {
		for _, q := range []string{`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('identity','security')`, `SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('identity','security') AND NOT t.tgisinternal`} {
			if count(t, db, q) != 0 {
				t.Fatal("custom database code found")
			}
		}
	}
}

type fixture struct {
	accounts, security *sql.DB
	service            application.Accounts
	sessions           application.Service
}

func setup(t *testing.T) *fixture {
	t.Helper()
	db, sec := testpostgres.Database(t), testpostgres.Database(t)
	var err error
	for range 2 {
		if err = migrations.Up(ctx, db); err != nil {
			t.Fatal(err)
		}
		if err = securitymigrations.Up(ctx, sec); err != nil {
			t.Fatal(err)
		}
	}
	auth, err := identityruntime.AccountsAuthorizer("gateway")
	if err != nil {
		t.Fatal(err)
	}
	client, err := securityruntime.New(sec, "identity-registrar", "player", testPolicy())
	if err != nil {
		t.Fatal(err)
	}
	sessionAuth, err := identityruntime.Authorizer("gateway")
	if err != nil {
		t.Fatal(err)
	}
	sessions := application.Service{Store: postgres.Store{DB: db}, Directory: postgres.Registry{DB: db}, Authorizer: sessionAuth, Clock: time.Now, ID: newID, Token: func() (string, error) {
		b := make([]byte, 32)
		_, e := rand.Read(b)
		return base64.RawURLEncoding.EncodeToString(b), e
	}}
	return &fixture{accounts: db, security: sec, sessions: sessions, service: application.Accounts{Grants: resourcegrants.Allows, Registry: postgres.Registry{DB: db}, Profiles: postgres.Registry{DB: db}, Sessions: sessions, Roles: roles.Subjects{Client: client}, Authorizer: auth, Clock: time.Now, ID: newID, Providers: []string{"telegram", "google"}}}
}
func count(t *testing.T, db *sql.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := db.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func provider(external string) application.ProviderIdentity {
	return application.ProviderIdentity{Provider: "telegram", ExternalID: external, DisplayName: "Player"}
}

func TestConcurrentResolveCreatesOneAccountAndOneDefaultRoleReceipt(t *testing.T) {
	f := setup(t)
	start := make(chan struct{})
	ids := make(chan string, 16)
	errs := make(chan error, 16)
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() { <-start; id, err := f.service.Resolve(ctx, provider("new-identity")); ids <- id; errs <- err })
	}
	close(start)
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	one := ""
	for id := range ids {
		if one == "" {
			one = id
		}
		if id != one {
			t.Fatal("provider resolved to multiple accounts", one, id)
		}
	}
	for _, q := range []string{`SELECT count(*) FROM identity.accounts`, `SELECT count(*) FROM identity.provider_links`, `SELECT count(*) FROM identity.registrations WHERE completed_at IS NOT NULL`} {
		if count(t, f.accounts, q) != 1 {
			t.Fatal(q)
		}
	}
	if count(t, f.security, `SELECT count(*) FROM security.subject_registrations`) != 1 || count(t, f.security, `SELECT count(*) FROM security.role_bindings WHERE true`) != 1 {
		t.Fatal("duplicate Security grant")
	}
	if count(t, f.accounts, `SELECT count(*) FROM identity.events`) != 2 {
		t.Fatal("duplicate lifecycle events")
	}
}

var lost = errors.New("simulated lost acknowledgement")

type lostAck struct {
	application.Roles
	fail atomic.Bool
}

func (a *lostAck) Register(ctx context.Context, id, subject string) (application.RoleReceipt, error) {
	r, err := a.Roles.Register(ctx, id, subject)
	if err == nil && a.fail.CompareAndSwap(true, false) {
		return application.RoleReceipt{}, lost
	}
	return r, err
}
func TestRecoveryAfterLostSecurityAcknowledgementDoesNotRestoreRevokedRole(t *testing.T) {
	f := setup(t)
	bridge := &lostAck{Roles: f.service.Roles}
	bridge.fail.Store(true)
	f.service.Roles = bridge
	if _, err := f.service.Resolve(ctx, provider("lost-ack")); !errors.Is(err, lost) {
		t.Fatal(err)
	}
	var id string
	if err := f.accounts.QueryRow(`SELECT id FROM identity.accounts`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if count(t, f.accounts, `SELECT count(*) FROM identity.registrations WHERE completed_at IS NULL`) != 1 {
		t.Fatal("registration was not durable")
	}
	if _, err := f.security.Exec(`DELETE FROM security.role_bindings WHERE subject=$1`, id); err != nil {
		t.Fatal(err)
	}
	// A policy change must not alter already accepted registration terms.
	changed, err := securityruntime.New(f.security, "identity-registrar", "admin", testPolicy())
	if err != nil {
		t.Fatal(err)
	}
	f.service.Roles = roles.Subjects{Client: changed}
	worker := application.WithAuthenticatedPrincipal(context.Background(), application.Principal{Kind: "service", ID: identityruntime.RegistrationWorker})
	var next time.Time
	if err := f.accounts.QueryRow(`SELECT next_attempt_at FROM identity.registrations WHERE subject=$1`, id).Scan(&next); err != nil {
		t.Fatal(err)
	}
	f.service.Clock = func() time.Time { return next.Add(-time.Second) }
	if n, err := f.service.ResumePending(worker, 64); err != nil || n != 0 {
		t.Fatal("retry delay was ignored", n, err)
	}
	f.service.Clock = func() time.Time { return next.Add(time.Second) }
	if n, err := f.service.ResumePending(worker, 64); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	if count(t, f.security, `SELECT count(*) FROM security.role_bindings WHERE subject=$1`, id) != 0 {
		t.Fatal("recovery restored a revoked role")
	}
	if count(t, f.security, `SELECT count(*) FROM security.subject_registrations WHERE role='player'`) != 1 {
		t.Fatal("replay changed original role")
	}
	if count(t, f.accounts, `SELECT count(*) FROM identity.registrations WHERE completed_at IS NULL`) != 0 {
		t.Fatal("registration did not recover")
	}
	resolved, err := f.service.Resolve(ctx, provider("lost-ack"))
	if err != nil || resolved != id {
		t.Fatal(resolved, err)
	}
	scopes, err := f.service.Permissions(ctx, id)
	if err != nil || scopes == nil || len(scopes) != 0 {
		t.Fatal("revocation was not reflected in current scopes", scopes, err)
	}
}

type lostCompletion struct {
	application.Registry
	fail atomic.Bool
}

func (s *lostCompletion) Complete(ctx context.Context, r application.Registration, receipt application.RoleReceipt, at time.Time, cause application.Cause) error {
	err := s.Registry.Complete(ctx, r, receipt, at, cause)
	if err == nil && s.fail.CompareAndSwap(true, false) {
		return lost
	}
	return err
}
func TestLostCompletionResponseDoesNotRepeatGrantOrAudit(t *testing.T) {
	f := setup(t)
	registry := &lostCompletion{Registry: f.service.Registry}
	registry.fail.Store(true)
	f.service.Registry = registry
	if _, err := f.service.Resolve(ctx, provider("complete-ack")); !errors.Is(err, lost) {
		t.Fatal(err)
	}
	if _, err := f.service.Resolve(ctx, provider("complete-ack")); err != nil {
		t.Fatal(err)
	}
	if count(t, f.accounts, `SELECT count(*) FROM identity.events`) != 2 || count(t, f.security, `SELECT count(*) FROM security.subject_registrations`) != 1 {
		t.Fatal("completion replay repeated effects")
	}
}
func TestRepeatedResolveNeverReprovisionsRevokedAccount(t *testing.T) {
	f := setup(t)
	id, err := f.service.Resolve(ctx, provider("repeat"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.security.Exec(`DELETE FROM security.role_bindings WHERE subject=$1`, id); err != nil {
		t.Fatal(err)
	}
	again, err := f.service.Resolve(ctx, provider("repeat"))
	if err != nil || again != id {
		t.Fatal(again, err)
	}
	if _, err = f.service.Link(ctx, f.linkRequest(t, id, "unapproved")); err == nil {
		t.Fatal("revoked account linked a provider")
	}
	if count(t, f.accounts, `SELECT count(*) FROM identity.accounts`) != 1 || count(t, f.security, `SELECT count(*) FROM security.subject_registrations`) != 1 || count(t, f.security, `SELECT count(*) FROM security.role_bindings`) != 0 {
		t.Fatal("resolve recreated account or restored role")
	}
}

func TestConcurrentLinksCannotCaptureAnotherAccountsProvider(t *testing.T) {
	f := setup(t)
	alice, err := f.service.Resolve(ctx, provider("alice"))
	if err != nil {
		t.Fatal(err)
	}
	bob, err := f.service.Resolve(ctx, provider("bob"))
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan string, 2)
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, id := range []string{alice, bob} {
		wg.Go(func() {
			owner, err := f.service.Link(ctx, f.linkRequest(t, id, "one-google-identity"))
			results <- owner
			errs <- err
		})
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	success := 0
	for result := range results {
		if result == "" {
			success++
		}
	}
	if success != 1 {
		t.Fatal("provider linked to two accounts", success)
	}
	if count(t, f.accounts, `SELECT count(*) FROM identity.provider_links WHERE provider='google' AND external_id='one-google-identity'`) != 1 || count(t, f.accounts, `SELECT count(*) FROM identity.events WHERE kind='linked'`) != 1 {
		t.Fatal("link invariants failed")
	}
}
func TestPermissionsAndCatalogUseVersionedRoleDefinitions(t *testing.T) {
	f := setup(t)
	id, err := f.service.Resolve(ctx, provider("reader"))
	if err != nil {
		t.Fatal(err)
	}
	scopes, err := f.service.Permissions(ctx, id)
	if err != nil || len(scopes) != 2 {
		t.Fatal(scopes, err)
	}
	policy := testPolicy()
	policy.Version = "test-v2"
	policy.Roles = append(policy.Roles, securityapp.RoleDefinition{ID: "base", Permissions: []securityapp.Permission{{Resource: "/api/v1/wallet", Action: "GET"}}})
	policy.Roles[0].Parents = []string{"base"}
	client, err := securityruntime.New(f.security, "identity-registrar", "player", policy)
	if err != nil {
		t.Fatal(err)
	}
	f.service.Roles = roles.Subjects{Client: client}
	scopes, err = f.service.Permissions(ctx, id)
	if err != nil || len(scopes) != 3 {
		t.Fatal(scopes, err)
	}
	catalog, err := f.service.Catalog(ctx)
	if err != nil || len(catalog) != 4 {
		t.Fatal(catalog, err)
	}
	if _, err = f.service.Permissions(ctx, "unknown"); err == nil {
		t.Fatal("unknown account got scopes")
	}
}

func role(t *testing.T, db *sql.DB, policy postgrespermissions.Policy) {
	t.Helper()
	id, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	name := "runtime_" + id[:16]
	if _, err = db.Exec(`CREATE ROLE ` + name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`RESET ROLE`)
		_, _ = db.Exec(`DROP OWNED BY ` + name)
		_, _ = db.Exec(`DROP ROLE ` + name)
	})
	if err = postgrespermissions.Apply(ctx, db, name, policy); err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec(`SET ROLE ` + name); err != nil {
		t.Fatal(err)
	}
}
func TestDedicatedRuntimeRolesCannotRewriteBindingOrRegistrationHistory(t *testing.T) {
	f := setup(t)
	role(t, f.accounts, postgres.RuntimePrivileges())
	role(t, f.security, securitypg.RuntimePrivileges())
	if _, err := f.service.Resolve(ctx, provider("limited")); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{`UPDATE identity.provider_links SET account_id='other'`, `DELETE FROM identity.provider_links`, `DELETE FROM identity.events`, `UPDATE identity.events SET kind='created'`} {
		if _, err := f.accounts.Exec(statement); err == nil {
			t.Fatal("excessive registry privilege", statement)
		}
	}
	for _, statement := range []string{`DELETE FROM security.subject_registrations`, `UPDATE security.subject_registrations SET role='admin'`, `DELETE FROM security.role_bindings`} {
		if _, err := f.security.Exec(statement); err == nil {
			t.Fatal("excessive registration privilege", statement)
		}
	}
}

func testPolicy() securityapp.RolePolicySpec {
	return securityapp.RolePolicySpec{Version: "test-roles-v1", Roles: []securityapp.RoleDefinition{
		{ID: "player", Permissions: []securityapp.Permission{{Resource: "/api/v1/me", Action: "GET"}, {Resource: "/identity/accounts/*", Action: "LINK"}}},
		{ID: "admin", Permissions: []securityapp.Permission{{Resource: "/api/v1/access", Action: "POST"}}},
	}}
}

func TestFreshContextsHaveNoOldAccountOrPolicyTables(t *testing.T) {
	f := setup(t)
	for _, db := range []*sql.DB{f.accounts, f.security} {
		for _, name := range []string{"public.users", "public.identities", "public.casbin_rule"} {
			var exists bool
			if err := db.QueryRow(`SELECT to_regclass($1) IS NOT NULL`, name).Scan(&exists); err != nil || exists {
				t.Fatal("old table dependency", name, exists, err)
			}
		}
	}
	if _, err := f.service.Resolve(ctx, provider("fresh-context")); err != nil {
		t.Fatal(err)
	}
}

func (f fixture) linkRequest(t *testing.T, id, external string) application.LinkRequest {
	t.Helper()
	session, err := f.sessions.Issue(ctx, application.Issue{Subject: id, TTLSeconds: 3600})
	if err != nil {
		t.Fatal(err)
	}
	return application.LinkRequest{Subject: id, SessionID: session.SessionID, Scopes: []string{"LINK:/identity/accounts/" + id}, Identity: application.ProviderIdentity{Provider: "google", ExternalID: external}}
}

func TestProviderLinkRequiresCurrentSessionAndTokenGrantCeiling(t *testing.T) {
	f := setup(t)
	id, err := f.service.Resolve(ctx, provider("link-proof"))
	if err != nil {
		t.Fatal(err)
	}
	input := f.linkRequest(t, id, "verified-google")
	missingGrant := input
	missingGrant.Scopes = []string{"GET:/api/v1/me"}
	if _, err = f.service.Link(ctx, missingGrant); !errors.Is(err, domain.ErrForbidden) {
		t.Fatal("link accepted token without grant", err)
	}
	other, err := f.service.Resolve(ctx, provider("other-user"))
	if err != nil {
		t.Fatal(err)
	}
	wrongOwner := input
	wrongOwner.Subject = other
	wrongOwner.Scopes = []string{"LINK:/identity/accounts/" + other}
	if _, err = f.service.Link(ctx, wrongOwner); err == nil {
		t.Fatal("link accepted another account's session")
	}
	if err = f.sessions.Revoke(ctx, input.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Link(ctx, input); err == nil {
		t.Fatal("link accepted revoked session")
	}
	if n := count(t, f.accounts, `SELECT count(*) FROM identity.provider_links WHERE provider='google'`); n != 0 {
		t.Fatal("failed proof mutated provider mapping", n)
	}
}

func TestRecipientRejectsMalformedQueriesAndUnsafeDisplayNames(t *testing.T) {
	f := setup(t)
	f.service.Recipient = postgres.Registry{DB: f.accounts}
	id, err := f.service.Resolve(ctx, provider("recipient"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.accounts.Exec(`UPDATE identity.accounts SET display_name=$2 WHERE id=$1`, id, "Bob\u202e"); err != nil {
		t.Fatal(err)
	}
	role(t, f.accounts, postgres.RuntimePrivileges())
	role(t, f.security, securitypg.RuntimePrivileges())
	for _, query := range []string{"bob\x00", string([]byte{0xff}), "bob\n", "bob\u202e"} {
		if _, err := f.service.ResolveRecipient(ctx, query); !errors.Is(err, domain.ErrInvalid) {
			t.Fatalf("query %q: %v", query, err)
		}
	}
	for _, bad := range []string{"Bob\x00", "Bob\u202e", "Bob\u200b", "Bob\u2028", "Bob\u2029"} {
		p := provider("unsafe")
		p.DisplayName = bad
		if _, err := f.service.Resolve(ctx, p); !errors.Is(err, domain.ErrInvalid) {
			t.Fatalf("provider %q: %v", bad, err)
		}
	}
	if _, err = f.service.ResolveRecipient(ctx, id); !errors.Is(err, domain.ErrInvalid) {
		t.Fatal("unsafe persisted name returned", err)
	}
}

func TestRecipientLookupDoesNotRevealLegacyTelegramHandles(t *testing.T) {
	f := setup(t)
	f.service.Recipient = postgres.Registry{DB: f.accounts}
	id, err := f.service.Resolve(ctx, provider("123456"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.accounts.Exec(`UPDATE identity.accounts SET handle='tg_123456' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	role(t, f.accounts, postgres.RuntimePrivileges())
	role(t, f.security, securitypg.RuntimePrivileges())
	if _, err = f.service.ResolveRecipient(ctx, "tg_123456"); !errors.Is(err, application.ErrConflict) {
		t.Fatal("legacy Telegram ID was discoverable", err)
	}
	if p, err := f.service.Profile(ctx, id); err != nil || p.Handle != "u_"+id {
		t.Fatal("own profile must show the usable opaque handle", p, err)
	}
	for _, query := range []string{id, "u_" + id} {
		p, err := f.service.ResolveRecipient(ctx, query)
		if err != nil || p.ID != id || p.Handle != "u_"+id {
			t.Fatal(p, err)
		}
	}
}

func TestOpaqueRecipientHandleSupportsMaximumLengthAccountID(t *testing.T) {
	f := setup(t)
	f.service.Recipient = postgres.Registry{DB: f.accounts}
	id := strings.Repeat("a", 160)
	f.service.ID = func() (string, error) { return id, nil }
	if _, err := f.service.Resolve(ctx, provider("long-account")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.accounts.Exec(`UPDATE identity.accounts SET handle='tg_123456' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	role(t, f.accounts, postgres.RuntimePrivileges())
	role(t, f.security, securitypg.RuntimePrivileges())
	p, err := f.service.ResolveRecipient(ctx, "u_"+id)
	if err != nil || p.ID != id || p.Handle != "u_"+id {
		t.Fatal(p, err)
	}
}
