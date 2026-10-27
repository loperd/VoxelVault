package postgres_test

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/voxel-vault/api/identity/adapters/postgres"
	"github.com/voxel-vault/api/identity/adapters/postgres/migrations"
	"github.com/voxel-vault/api/identity/application"
	"github.com/voxel-vault/api/identity/domain"
	"github.com/voxel-vault/api/internal/identityruntime"
	"github.com/voxel-vault/api/platform/postgrespermissions"
	"github.com/voxel-vault/api/platform/testpostgres"
)

type directory struct{}

func (directory) Exists(_ context.Context, id string) (bool, error) { return id == "alice", nil }

var ctx = application.WithAuthenticatedPrincipal(context.Background(), application.Principal{Kind: "service", ID: "gateway-a"})

func token() (string, error) {
	b := make([]byte, 32)
	_, err := rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b), err
}
func fixture(t *testing.T) (*sql.DB, application.Service) {
	t.Helper()
	db := testpostgres.Database(t)
	if err := migrations.Up(ctx, db); err != nil {
		t.Fatal(err)
	}
	if err := migrations.Up(ctx, db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO identity.accounts(id,handle,display_name,created_at,updated_at) VALUES('alice','alice','Alice',$1,$1)`, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	auth, err := identityruntime.Authorizer("gateway-a")
	if err != nil {
		t.Fatal(err)
	}
	return db, application.Service{Store: postgres.Store{DB: db}, Directory: directory{}, Authorizer: auth, Clock: time.Now, ID: func() (string, error) {
		b := make([]byte, 16)
		_, err := rand.Read(b)
		return hex.EncodeToString(b), err
	}, Token: token}
}
func issue(t *testing.T, s application.Service) application.Issued {
	t.Helper()
	v, err := s.Issue(ctx, application.Issue{Subject: "alice", TTLSeconds: 3600})
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func count(t *testing.T, db *sql.DB, table string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM identity.` + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRotationReplayRevokesFamilyAndKeepsAuditWithoutPlaintext(t *testing.T) {
	db, s := fixture(t)
	v := issue(t, s)
	if err := s.Validate(ctx, v.SessionID, "alice"); err != nil {
		t.Fatal(err)
	}
	if err := s.Validate(ctx, v.SessionID, "other"); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatal("foreign subject validated", err)
	}
	r, err := s.Refresh(ctx, v.SessionID, v.RefreshToken)
	if err != nil || r.Subject != "alice" || r.RefreshToken == v.RefreshToken {
		t.Fatal(r, err)
	}
	if _, err = s.Refresh(ctx, v.SessionID, v.RefreshToken); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatal("replay accepted", err)
	}
	// This must remain revoked after the failed refresh transaction commits.
	if _, err = s.Refresh(ctx, v.SessionID, r.RefreshToken); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatal("replay revocation rolled back", err)
	}
	if err := s.Validate(ctx, v.SessionID, "alice"); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatal("revoked session validated", err)
	}
	var revoked bool
	var events string
	if err = db.QueryRow(`SELECT revoked_at IS NOT NULL FROM identity.sessions WHERE id=$1`, v.SessionID).Scan(&revoked); err != nil || !revoked {
		t.Fatal(revoked, err)
	}
	if err = db.QueryRow(`SELECT string_agg(kind,',' ORDER BY id) FROM identity.session_events`).Scan(&events); err != nil || events != "issued,refreshed,replay_revoked" {
		t.Fatal(events, err)
	}
	var bad int
	if err = db.QueryRow(`SELECT count(*) FROM identity.refresh_tokens WHERE length(hash)<>64 OR hash=$1 OR hash=$2`, v.RefreshToken, r.RefreshToken).Scan(&bad); err != nil || bad != 0 {
		t.Fatal(bad, err)
	}
	if err = db.QueryRow(`SELECT count(*) FROM identity.session_events WHERE actor<>'gateway-a' OR policy_version<>'identity-session-rbac-v1'`).Scan(&bad); err != nil || bad != 0 {
		t.Fatal("missing authorization audit", bad, err)
	}
}
func TestUnknownTokenCannotRevokeAndExplicitRevocationIsIdempotent(t *testing.T) {
	db, s := fixture(t)
	v := issue(t, s)
	unknown, err := token()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Refresh(ctx, v.SessionID, unknown); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatal(err)
	}
	if count(t, db, "session_events") != 1 {
		t.Fatal("unknown token mutated session")
	}
	if _, err = s.Refresh(ctx, v.SessionID, v.RefreshToken); err != nil {
		t.Fatal("unknown token caused denial of service", err)
	}
	if err = s.Revoke(ctx, v.SessionID); err != nil {
		t.Fatal(err)
	}
	if err = s.Revoke(ctx, v.SessionID); err != nil {
		t.Fatal(err)
	}
	if count(t, db, "session_events") != 3 {
		t.Fatal("duplicate revoke event")
	}
}
func TestMissingIdentityRolesAndCrossIssuerAccessAreDenied(t *testing.T) {
	db, s := fixture(t)
	for _, c := range []context.Context{context.Background(), application.WithAuthenticatedPrincipal(context.Background(), application.Principal{Kind: "user", ID: "gateway-a"}), application.WithAuthenticatedPrincipal(context.Background(), application.Principal{Kind: "service", ID: "unknown"})} {
		if _, err := s.Issue(c, application.Issue{Subject: "alice", TTLSeconds: 3600}); !errors.Is(err, domain.ErrForbidden) {
			t.Fatal(err)
		}
	}
	if _, err := s.Issue(ctx, application.Issue{Subject: "unknown", TTLSeconds: 3600}); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatal(err)
	}
	if count(t, db, "sessions") != 0 {
		t.Fatal("denied issue created session")
	}
	v := issue(t, s)
	other := s
	var err error
	other.Authorizer, err = identityruntime.Authorizer("gateway-b")
	if err != nil {
		t.Fatal(err)
	}
	foreign := application.WithAuthenticatedPrincipal(context.Background(), application.Principal{Kind: "service", ID: "gateway-b"})
	if _, err = other.Refresh(foreign, v.SessionID, v.RefreshToken); !errors.Is(err, domain.ErrForbidden) {
		t.Fatal("cross issuer refresh", err)
	}
	if err = other.Revoke(foreign, v.SessionID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatal("cross issuer revoke", err)
	}
	if count(t, db, "session_events") != 1 {
		t.Fatal("foreign issuer wrote audit")
	}
}
func TestConcurrentRefreshSerializesAndAnyReplayRevokesWinner(t *testing.T) {
	db, s := fixture(t)
	v := issue(t, s)
	start := make(chan struct{})
	results := make(chan application.Refreshed, 16)
	failures := make(chan error, 16)
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() { <-start; r, err := s.Refresh(ctx, v.SessionID, v.RefreshToken); results <- r; failures <- err })
	}
	close(start)
	wg.Wait()
	close(results)
	close(failures)
	success := 0
	for err := range failures {
		if err == nil {
			success++
		} else if !errors.Is(err, domain.ErrUnauthenticated) {
			t.Fatal(err)
		}
	}
	if success != 1 {
		t.Fatal("multiple refresh winners", success)
	}
	for result := range results {
		if result.RefreshToken != "" {
			if _, err := s.Refresh(ctx, v.SessionID, result.RefreshToken); !errors.Is(err, domain.ErrUnauthenticated) {
				t.Fatal("winning token survived replay", err)
			}
		}
	}
	if count(t, db, "refresh_tokens") != 2 || count(t, db, "session_events") != 3 {
		t.Fatal("duplicate token or audit state")
	}
}
func TestExpiryAndMigrationContainNoDatabaseCode(t *testing.T) {
	db, s := fixture(t)
	at := time.Now().UTC().Truncate(time.Microsecond)
	s.Clock = func() time.Time { return at }
	v := issue(t, s)
	s.Clock = func() time.Time { return at.Add(time.Hour) }
	if _, err := s.Refresh(ctx, v.SessionID, v.RefreshToken); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatal("expired token rotated", err)
	}
	for _, q := range []string{`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='identity'`, `SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='identity' AND NOT t.tgisinternal`} {
		var n int
		if err := db.QueryRow(q).Scan(&n); err != nil || n != 0 {
			t.Fatal(n, err)
		}
	}
}

type failingStore struct{ application.Store }
type failingTx struct{ application.Tx }

var auditFailure = errors.New("injected session audit failure")

func (s failingStore) Transact(ctx context.Context, id string, fn func(application.Tx) error) error {
	return s.Store.Transact(ctx, id, func(tx application.Tx) error { return fn(failingTx{tx}) })
}
func (t failingTx) Save(row domain.Session, presented string, at time.Time, event application.Event) error {
	if err := t.Tx.Save(row, presented, at, event); err != nil {
		return err
	}
	return auditFailure
}
func TestFailedLocalCommitLeavesOldRefreshUsable(t *testing.T) {
	db, s := fixture(t)
	v := issue(t, s)
	failed := s
	failed.Store = failingStore{s.Store}
	if _, err := failed.Refresh(ctx, v.SessionID, v.RefreshToken); !errors.Is(err, auditFailure) {
		t.Fatal(err)
	}
	if count(t, db, "refresh_tokens") != 1 || count(t, db, "session_events") != 1 {
		t.Fatal("failed local transaction leaked state")
	}
	if _, err := s.Refresh(ctx, v.SessionID, v.RefreshToken); err != nil {
		t.Fatal("rolled-back token was consumed", err)
	}
}

func TestIdentityRuntimeRoleCanRotateButCannotAlterHistory(t *testing.T) {
	db, s := fixture(t)
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	role := "identity_runtime_" + hex.EncodeToString(b)
	if _, err := db.Exec(`CREATE ROLE ` + role); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`RESET ROLE`)
		_, _ = db.Exec(`DROP OWNED BY ` + role)
		_, _ = db.Exec(`DROP ROLE ` + role)
	})
	if err := postgrespermissions.Apply(ctx, db, role, postgres.RuntimePrivileges()); err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`SET ROLE ` + role); err != nil {
		t.Fatal(err)
	}
	v := issue(t, s)
	if _, err := s.Refresh(ctx, v.SessionID, v.RefreshToken); err != nil {
		t.Fatal(err)
	}
	if err := s.Revoke(ctx, v.SessionID); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{`DELETE FROM identity.sessions`, `DELETE FROM identity.refresh_tokens`, `UPDATE identity.session_events SET kind='issued'`, `DELETE FROM identity.session_events`, `UPDATE identity.sessions SET subject='other'`, `TRUNCATE identity.session_events`} {
		if _, err := db.Exec(statement); err == nil {
			t.Fatal("runtime role exceeded its context grants", statement)
		}
	}
}
