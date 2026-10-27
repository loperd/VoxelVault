package postgres_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/voxel-vault/api/internal/ledger/adapters/postgres"
	"github.com/voxel-vault/api/internal/ledger/adapters/postgres/migrations"
	"github.com/voxel-vault/api/internal/ledger/application"
	"github.com/voxel-vault/api/internal/ledger/domain"
	"github.com/voxel-vault/api/internal/platform/postgrespermissions"
)

var sequence atomic.Uint64
var ctx = context.Background()

type authorizer func(context.Context, string, domain.Action, *domain.Terms) error

func (a authorizer) Authorize(c context.Context, p string, action domain.Action, tr *domain.Terms) error {
	return a(c, p, action, tr)
}

var allowed = authorizer(func(_ context.Context, p string, _ domain.Action, tr *domain.Terms) error {
	if p != "inventory" {
		return application.ErrForbidden
	}
	if tr != nil && (tr.Subject != "player" || tr.Asset != "coins") {
		return application.ErrForbidden
	}
	return nil
})

// database returns a store running as the production runtime role.
func database(t *testing.T) (*sql.DB, *postgres.Store) { return open(t, true) }

// operatorDatabase is for opening and treasury setup, which production runs with operator
// credentials, never as the runtime role.
func operatorDatabase(t *testing.T) (*sql.DB, *postgres.Store) { return open(t, false) }

func open(t *testing.T, asRuntime bool) (*sql.DB, *postgres.Store) {
	t.Helper()
	dsn := os.Getenv("TEST_WALLET_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_WALLET_DATABASE_URL is required; tests create disposable databases")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("wallet_test_%d_%d", os.Getpid(), sequence.Add(1))
	if _, err = admin.ExecContext(ctx, `CREATE DATABASE `+name); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Path = "/" + name
	db, err := sql.Open("pgx", parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(24)
	t.Cleanup(func() {
		db.Close()
		if _, err := admin.ExecContext(ctx, `DROP DATABASE `+name+` WITH (FORCE)`); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	if err := migrations.Up(ctx, db); err != nil {
		t.Fatal(err)
	}
	if err := migrations.Up(ctx, db); err != nil {
		t.Fatal("repeat migration", err)
	}
	var version int64
	if err := db.QueryRow(`SELECT max(version_id) FROM wallet_schema_version`).Scan(&version); err != nil || version != 7 {
		t.Fatal(version, err)
	}
	if !asRuntime {
		return db, postgres.New(db).LimitQuotes(3, 2000).LimitTransfers(10, 60)
	}
	// The store runs as the production runtime role, so a missing or excess grant fails here.
	role := fmt.Sprintf("ledger_runtime_%d_%d", os.Getpid(), sequence.Add(1))
	if _, err = admin.ExecContext(ctx, `CREATE ROLE `+role+` LOGIN NOINHERIT PASSWORD 'runtime-test-only'`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := db.Exec(`DROP OWNED BY ` + role); err != nil {
			t.Error(err)
		}
	})
	if err = postgrespermissions.Apply(ctx, db, role, postgres.RuntimePrivileges()); err != nil {
		t.Fatal(err)
	}
	parsed.User = url.UserPassword(role, "runtime-test-only")
	runtime, err := sql.Open("pgx", parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	runtime.SetMaxOpenConns(24)
	t.Cleanup(func() { runtime.Close() })
	return db, postgres.New(runtime).LimitQuotes(3, 2000).LimitTransfers(10, 60)
}
func service(t *testing.T, store application.Store) *application.Service {
	t.Helper()
	s, err := application.New(store, allowed, func() time.Time { return time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC) })
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func command(id, intent string, action domain.Action, units int64) application.Command {
	c := application.Command{Producer: "inventory", ID: id, IntentID: intent, Action: action}
	if action == domain.Reserve || action == domain.Credit {
		purpose := domain.Spending
		if action == domain.Credit {
			purpose = domain.Reward
		}
		c.Terms = &domain.Terms{Subject: "player", Asset: "coins", Units: units, Purpose: purpose, Evidence: "quote-1"}
	}
	return c
}
func execute(t *testing.T, s *application.Service, c application.Command) application.Receipt {
	t.Helper()
	r, err := s.Execute(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func funds(t *testing.T, store *postgres.Store, posted, held int64) {
	t.Helper()
	f, err := store.Balance(ctx, "player", "coins")
	if err != nil || f.Posted != posted || f.Held != held {
		t.Fatal(f, err, "want", posted, held)
	}
}
func count(t *testing.T, db *sql.DB, table string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM ledger.` + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestDurableCaptureRetriesAndCommandConflicts(t *testing.T) {
	db, store := database(t)
	s := service(t, store)
	if _, err := s.Execute(ctx, command("capture", "repair", domain.Capture, 0)); !errors.Is(err, domain.ErrNotReady) {
		t.Fatal(err)
	}
	execute(t, s, command("fund", "fund", domain.Credit, 10))
	if r := execute(t, s, command("reserve", "repair", domain.Reserve, 8)); r.Intent.State != domain.Reserved {
		t.Fatal(r)
	}
	funds(t, store, 10, 8)
	if r := execute(t, s, command("other", "other-repair", domain.Reserve, 8)); r.Intent.State != domain.Declined {
		t.Fatal(r)
	}
	// A new service/repository instance reads the committed intent and receipt, without session state.
	restarted := service(t, postgres.New(db))
	a := execute(t, restarted, command("capture", "repair", domain.Capture, 0))
	b := execute(t, restarted, command("capture", "repair", domain.Capture, 0))
	if a.JournalID == "" || a.JournalID != b.JournalID || a.Intent.State != domain.Captured {
		t.Fatal(a, b)
	}
	execute(t, restarted, command("capture-again", "repair", domain.Capture, 0))
	execute(t, restarted, command("cancel-after", "repair", domain.Cancel, 0))
	funds(t, store, 2, 0)
	if count(t, db, "journals") != 2 {
		t.Fatal("capture duplicated")
	}
	if _, err := s.Execute(ctx, command("reserve", "repair", domain.Reserve, 7)); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("command ID conflict", err)
	}
	if _, err := s.Execute(ctx, command("reserve-new-id", "repair", domain.Reserve, 7)); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("business intent conflict", err)
	}
	events, err := store.PendingEvents(ctx)
	if err != nil || len(events) != 4 {
		t.Fatal(len(events), err)
	}
}
func TestCancellationAndClosureFenceUnknownIntents(t *testing.T) {
	db, store := database(t)
	s := service(t, store)
	execute(t, s, command("cancel", "late-reserve", domain.Cancel, 0))
	if r := execute(t, s, command("reserve", "late-reserve", domain.Reserve, 8)); r.Intent.State != domain.Canceled {
		t.Fatal(r)
	}
	execute(t, s, command("close", "late-award", domain.Close, 0))
	if r := execute(t, s, command("credit", "late-award", domain.Credit, 4)); r.Intent.State != domain.Closed {
		t.Fatal(r)
	}
	funds(t, store, 0, 0)
	if count(t, db, "journals") != 0 || count(t, db, "holds") != 0 {
		t.Fatal("late command crossed fence")
	}
	execute(t, s, command("fresh-award", "fresh-award", domain.Credit, 4))
	if r := execute(t, s, command("close-paid", "fresh-award", domain.Close, 0)); r.Intent.State != domain.Credited {
		t.Fatal(r)
	}
	funds(t, store, 4, 0)
}
func TestConcurrentReservationsCannotOverspend(t *testing.T) {
	_, store := database(t)
	s := service(t, store)
	execute(t, s, command("fund", "fund", domain.Credit, 10))
	const workers = 20
	results := make(chan application.Receipt, workers)
	errs := make(chan error, workers)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for n := range workers {
		wg.Go(func() {
			<-start
			r, err := s.Execute(ctx, command(fmt.Sprint("reserve-", n), fmt.Sprint("intent-", n), domain.Reserve, 8))
			results <- r
			errs <- err
		})
	}
	close(start)
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	winners := 0
	for r := range results {
		if r.Intent.State == domain.Reserved {
			winners++
		} else if r.Intent.State != domain.Declined {
			t.Fatal(r)
		}
	}
	if winners != 1 {
		t.Fatal("reservations granted", winners)
	}
	funds(t, store, 10, 8)
}
func TestConcurrentReplayedCreditsAndCloseRace(t *testing.T) {
	db, store := database(t)
	s := service(t, store)
	start := make(chan struct{})
	errs := make(chan error, 20)
	var wg sync.WaitGroup
	for n := range 20 {
		wg.Go(func() {
			<-start
			_, err := s.Execute(ctx, command(fmt.Sprint("award-", n), "one-award", domain.Credit, 4))
			errs <- err
		})
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	funds(t, store, 4, 0)
	if count(t, db, "journals") != 1 {
		t.Fatal("business duplicate")
	}
	for n := range 10 {
		intent := fmt.Sprint("race-", n)
		var credit, closed application.Receipt
		var e1, e2 error
		var race sync.WaitGroup
		race.Go(func() { credit, e1 = s.Execute(ctx, command(intent+"-credit", intent, domain.Credit, 1)) })
		race.Go(func() { closed, e2 = s.Execute(ctx, command(intent+"-close", intent, domain.Close, 0)) })
		race.Wait()
		if e1 != nil || e2 != nil {
			t.Fatal(e1, e2)
		}
		if credit.Intent.State != closed.Intent.State {
			t.Fatal("credit/close disagreed", credit, closed)
		}
	}
}

var fault = errors.New("injected outbox write failure")

type faultStore struct{ application.Store }

func (f faultStore) Transact(ctx context.Context, fn func(application.Tx) error) error {
	return f.Store.Transact(ctx, func(tx application.Tx) error { return fn(faultTx{tx}) })
}

type faultTx struct{ application.Tx }

func (faultTx) Enqueue(application.Event) error { return fault }
func TestFailureRollsBackJournalIntentReceiptAndOutbox(t *testing.T) {
	db, store := database(t)
	broken := service(t, faultStore{store})
	c := command("award", "award", domain.Credit, 4)
	if _, err := broken.Execute(ctx, c); !errors.Is(err, fault) {
		t.Fatal(err)
	}
	for _, table := range []string{"journals", "postings", "intents", "commands", "outbox", "accounts"} {
		if count(t, db, table) != 0 {
			t.Fatal("partial commit", table)
		}
	}
	execute(t, service(t, store), c)
	funds(t, store, 4, 0)
}
func TestGoAdapterRejectsUnbalancedAndDuplicateJournals(t *testing.T) {
	db, repository := database(t)
	service := service(t, repository)
	receipt := execute(t, service, command("award", "award", domain.Credit, 4))
	err := repository.Transact(ctx, func(tx application.Tx) error {
		return tx.AppendJournal(domain.Journal{ID: "bad", Producer: "inventory", IntentID: "bad", Asset: "coins", At: time.Now()})
	})
	if !errors.Is(err, domain.ErrInvalid) {
		t.Fatal("empty journal accepted", err)
	}
	var raw []byte
	if err = db.QueryRow(`SELECT body FROM ledger.intents WHERE producer='inventory' AND id='award'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var intent domain.Intent
	if err = json.Unmarshal(raw, &intent); err != nil {
		t.Fatal(err)
	}
	journal, err := domain.SettlementJournal(intent, domain.Credit, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	err = repository.Transact(ctx, func(tx application.Tx) error { return tx.AppendJournal(journal) })
	if err == nil {
		t.Fatal("duplicate journal accepted", receipt)
	}
	funds(t, repository, 4, 0)
	if count(t, db, "journals") != 1 {
		t.Fatal("invalid journal persisted")
	}
}
func TestAuthorizationPrecedesMutations(t *testing.T) {
	db, store := database(t)
	s := service(t, store)
	bad := command("award", "award", domain.Credit, 4)
	bad.Terms.Subject = "another-player"
	if _, err := s.Execute(ctx, bad); !errors.Is(err, application.ErrForbidden) {
		t.Fatal(err)
	}
	if count(t, db, "commands") != 0 {
		t.Fatal("unauthorized command persisted")
	}
}

func TestReservedFundsAreReleasedExactlyOnce(t *testing.T) {
	db, store := database(t)
	s := service(t, store)
	execute(t, s, command("fund", "fund", domain.Credit, 10))
	execute(t, s, command("reserve", "repair", domain.Reserve, 8))
	execute(t, s, command("cancel", "repair", domain.Cancel, 0))
	execute(t, s, command("cancel-again", "repair", domain.Cancel, 0))
	if r := execute(t, s, command("late-capture", "repair", domain.Capture, 0)); r.Intent.State != domain.Canceled {
		t.Fatal(r)
	}
	funds(t, store, 10, 0)
	if count(t, db, "journals") != 1 {
		t.Fatal("canceled repair posted a debit")
	}
}

func TestMigrationProvidersSerializeAndRejectRollback(t *testing.T) {
	db, _ := database(t)
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for range 4 {
		wg.Go(func() { errs <- migrations.Up(ctx, db) })
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	provider, err := migrations.Provider(db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Down(ctx); err == nil {
		t.Fatal("financial migration was silently rolled back")
	}
	if err := migrations.Up(ctx, db); err != nil {
		t.Fatal("failed rollback damaged migration state", err)
	}
}

func TestCaptureAndCancellationHaveOneTerminalOutcome(t *testing.T) {
	db, store := database(t)
	s := service(t, store)
	execute(t, s, command("fund", "fund", domain.Credit, 200))
	var spent int64
	for n := range 12 {
		intent := fmt.Sprint("repair-race-", n)
		execute(t, s, command(intent+"-reserve", intent, domain.Reserve, 8))
		var capture, cancel application.Receipt
		var a, b error
		var wg sync.WaitGroup
		wg.Go(func() { capture, a = s.Execute(ctx, command(intent+"-capture", intent, domain.Capture, 0)) })
		wg.Go(func() { cancel, b = s.Execute(ctx, command(intent+"-cancel", intent, domain.Cancel, 0)) })
		wg.Wait()
		if a != nil || b != nil {
			t.Fatal(a, b)
		}
		if capture.Intent.State != cancel.Intent.State {
			t.Fatal("conflicting terminal receipts", capture, cancel)
		}
		if capture.Intent.State == domain.Captured {
			spent += 8
		} else if capture.Intent.State != domain.Canceled {
			t.Fatal(capture)
		}
	}
	funds(t, store, 200-spent, 0)
	var bad int
	if err := db.QueryRow(`SELECT count(*) FROM (SELECT journal_id FROM ledger.postings GROUP BY journal_id HAVING sum(CASE side WHEN 'debit' THEN units::numeric ELSE -units::numeric END)<>0) bad`).Scan(&bad); err != nil || bad != 0 {
		t.Fatal(bad, err)
	}
}

func TestScopedReadsDoNotCreateAnIntentOrBypassAuthorization(t *testing.T) {
	db, store := database(t)
	s := service(t, store)
	missing, err := s.Status(ctx, "inventory", "not-delivered-yet")
	if err != nil || missing.Intent.State != domain.Missing {
		t.Fatal(missing, err)
	}
	if count(t, db, "intents") != 0 {
		t.Fatal("status read created an intent")
	}
	paid := execute(t, s, command("award", "award", domain.Credit, 4))
	status, err := service(t, postgres.New(db)).Status(ctx, "inventory", "award")
	if err != nil || status.JournalID != paid.JournalID {
		t.Fatal(status, err)
	}
	if _, err := s.Status(ctx, "unknown-producer", "award"); !errors.Is(err, application.ErrForbidden) {
		t.Fatal(err)
	}
	if _, err := s.Balance(ctx, "inventory", "another-player", "coins"); !errors.Is(err, application.ErrForbidden) {
		t.Fatal(err)
	}
	f, err := s.Balance(ctx, "inventory", "player", "coins")
	if err != nil || f.Posted != 4 {
		t.Fatal(f, err)
	}
}

func TestHoldIsKeptAndEndsAsStatus(t *testing.T) {
	db, store := database(t)
	s := service(t, store)
	execute(t, s, command("fund", "fund", domain.Credit, 100))
	execute(t, s, command("r1", "h1", domain.Reserve, 30))
	funds(t, store, 100, 30)
	execute(t, s, command("c1", "h1", domain.Capture, 0))
	execute(t, s, command("r2", "h2", domain.Reserve, 20))
	execute(t, s, command("x2", "h2", domain.Cancel, 0))
	var captured, released, held int
	if err := db.QueryRow(`SELECT count(*) FILTER (WHERE status='captured'),count(*) FILTER (WHERE status='released'),count(*) FILTER (WHERE status='held') FROM ledger.holds`).Scan(&captured, &released, &held); err != nil || captured != 1 || released != 1 || held != 0 {
		t.Fatal(captured, released, held, err)
	}
}

// An older release granted DELETE on holds; re-applying the policy must revoke it, not fail the audit.
func TestRuntimeGrantsRevokeLegacyHoldDelete(t *testing.T) {
	db, store := operatorDatabase(t)
	s := service(t, store)
	execute(t, s, command("fund", "fund", domain.Credit, 100))
	execute(t, s, command("reserve", "retained-hold", domain.Reserve, 30))
	role := fmt.Sprintf("ledger_legacy_%d_%d", os.Getpid(), sequence.Add(1))
	if _, err := db.ExecContext(ctx, `CREATE ROLE `+role+` NOINHERIT`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Exec(`DROP OWNED BY ` + role); db.Exec(`DROP ROLE ` + role) })
	if err := postgrespermissions.Apply(ctx, db, role, postgres.RuntimePrivileges()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `GRANT DELETE ON ledger.holds TO `+role); err != nil {
		t.Fatal(err)
	}
	if err := postgrespermissions.Apply(ctx, db, role, postgres.RuntimePrivileges()); err != nil {
		t.Fatal("re-apply", err)
	}
	var can bool
	if err := db.QueryRowContext(ctx, `SELECT has_table_privilege($1,'ledger.holds','DELETE')`, role).Scan(&can); err != nil || can {
		t.Fatal("DELETE on holds survived", can, err)
	}
	if err := postgrespermissions.Apply(ctx, db, role, postgres.RuntimePrivileges()); err != nil {
		t.Fatal("repeat policy application", err)
	}
	// Execute under the actual runtime role, not the operator's privileges.
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SET LOCAL ROLE `+role); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, `UPDATE ledger.holds SET status='released' WHERE false`); err != nil {
		t.Fatal("status update must remain allowed", err)
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM ledger.holds WHERE false`); err == nil {
		t.Fatal("runtime role can still delete holds")
	} else {
		var denied interface{ SQLState() string }
		if !errors.As(err, &denied) || denied.SQLState() != "42501" {
			t.Fatal("expected insufficient_privilege", err)
		}
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if count(t, db, "holds") != 1 {
		t.Fatal("grant replacement changed hold records")
	}
	funds(t, store, 100, 30)
}

func TestRuntimeGrantRevocationRollsBackWhenOtherExcessPrivilegesRemain(t *testing.T) {
	db, _ := operatorDatabase(t)
	role := fmt.Sprintf("ledger_excess_%d_%d", os.Getpid(), sequence.Add(1))
	if _, err := db.ExecContext(ctx, `CREATE ROLE `+role+` NOINHERIT`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Exec(`DROP OWNED BY ` + role); db.Exec(`DROP ROLE ` + role) })
	if err := postgrespermissions.Apply(ctx, db, role, postgres.RuntimePrivileges()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `GRANT DELETE ON ledger.holds, ledger.journals TO `+role); err != nil {
		t.Fatal(err)
	}
	if err := postgrespermissions.Apply(ctx, db, role, postgres.RuntimePrivileges()); err == nil {
		t.Fatal("unlisted DELETE on journals must fail the audit")
	}
	for _, table := range []string{"ledger.holds", "ledger.journals"} {
		var can bool
		if err := db.QueryRowContext(ctx, `SELECT has_table_privilege($1,$2,'DELETE')`, role, table).Scan(&can); err != nil || !can {
			t.Fatal("failed policy update must roll back its revocations", table, can, err)
		}
	}
}
