package economycutover_test

import (
	"bytes"
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
	cutover "github.com/voxel-vault/api/internal/economycutover"
	"github.com/voxel-vault/api/internal/economycutover/adapters/legacy"
	lmigrate "github.com/voxel-vault/api/internal/economycutover/adapters/legacy/migrations"
	ilocal "github.com/voxel-vault/api/internal/inventory/adapters/inbound/local"
	ipg "github.com/voxel-vault/api/internal/inventory/adapters/postgres"
	imigrate "github.com/voxel-vault/api/internal/inventory/adapters/postgres/migrations"
	inv "github.com/voxel-vault/api/internal/inventory/application"
	iv1 "github.com/voxel-vault/api/internal/inventory/contracts/v1"
	"github.com/voxel-vault/api/internal/ledger/adapters/authorization"
	wlocal "github.com/voxel-vault/api/internal/ledger/adapters/inbound/local"
	wpg "github.com/voxel-vault/api/internal/ledger/adapters/postgres"
	wmigrate "github.com/voxel-vault/api/internal/ledger/adapters/postgres/migrations"
	wallet "github.com/voxel-vault/api/internal/ledger/application"
	wv1 "github.com/voxel-vault/api/internal/ledger/contracts/v1"
	wdomain "github.com/voxel-vault/api/internal/ledger/domain"
	"github.com/voxel-vault/api/internal/store"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

var dbSeq atomic.Uint64
var ctx = inv.WithAuthenticatedPrincipal(context.Background(), inv.Principal{Kind: "operator", ID: "test-fixture"})

func database(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("TEST_WALLET_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_WALLET_DATABASE_URL must allow disposable database creation")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("cutover_test_%d_%d", os.Getpid(), dbSeq.Add(1))
	if _, err = admin.Exec(`CREATE DATABASE ` + name + ` ENCODING 'UTF8' TEMPLATE template0`); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(16)
	t.Cleanup(func() {
		db.Close()
		if _, err := admin.Exec(`DROP DATABASE ` + name + ` WITH(FORCE)`); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	return db
}
func exec(t *testing.T, db *sql.DB, q string, args ...any) {
	t.Helper()
	if _, err := db.Exec(q, args...); err != nil {
		t.Fatal(err)
	}
}
func count(t *testing.T, db *sql.DB, table string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM ` + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

type fixture struct {
	source, wdb, idb *sql.DB
	wallet           wv1.OpeningClient
	inventory        iv1.OpeningClient
}

func (f *fixture) clients(t *testing.T, assets []string, purpose wdomain.Purpose) (wv1.OpeningClient, iv1.OpeningClient) {
	t.Helper()
	p, err := authorization.New([]authorization.Grant{{Producer: "legacy-opening", Actions: []wdomain.Action{wdomain.Credit}, Assets: assets, AllSubjects: true, Purposes: []wdomain.Purpose{purpose}}})
	if err != nil {
		t.Fatal(err)
	}
	return wlocal.OpeningClient{Service: wallet.OpeningService{Store: wpg.New(f.wdb), Authorizer: allowIssuance{p}, Producer: "legacy-opening"}}, ilocal.OpeningClient{Service: inv.OpeningService{Authorizer: allowInventory{}, Store: ipg.New(f.idb)}}
}
func setup(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{source: database(t), wdb: database(t), idb: database(t)}
	g, err := gorm.Open(postgres.New(postgres.Config{Conn: f.source}), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err = g.AutoMigrate(&store.EconomyOwner{}, &store.ChestInstance{}, &store.InventoryItem{}, &store.WalletBalance{}); err != nil {
		t.Fatal(err)
	}
	for _, u := range []store.EconomyOwner{{ID: "alice"}, {ID: "bob"}} {
		if err = g.Create(&u).Error; err != nil {
			t.Fatal(err)
		}
	}
	chest := store.ChestInstance{ID: "chest-a", UserID: "alice", CaseID: "forest", Status: "available", Seed: 9007199254740993, Contents: []byte(`[{"Item":"compass","Weight":1}]`), Traits: []byte(`[]`), OriginParents: []byte(`[]`), Revision: "v1", Rarity: "common", Condition: 0.75}
	if err = g.Create(&chest).Error; err != nil {
		t.Fatal(err)
	}
	for _, item := range []store.InventoryItem{{ID: "item-a", UserID: "alice", ItemID: "compass", State: "heavy", Origin: "chest-a"}, {ID: "item-b", UserID: "bob", ItemID: "lamp", State: "intact", Origin: ""}} {
		if err = g.Create(&item).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, b := range []store.WalletBalance{{UserID: "alice", Resource: "coins", Value: 9007199254740993}, {UserID: "alice", Resource: "ore", Value: 9}, {UserID: "bob", Resource: "coins", Value: 0}} {
		if err = g.Create(&b).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, m := range []struct {
		db *sql.DB
		up func(context.Context, *sql.DB) error
	}{{f.source, lmigrate.Up}, {f.wdb, wmigrate.Up}, {f.idb, imigrate.Up}} {
		if err = m.up(ctx, m.db); err != nil {
			t.Fatal(err)
		}
	}
	f.wallet, f.inventory = f.clients(t, []string{"coins", "ore"}, wdomain.OpeningBalance)
	return f
}
func (f *fixture) freeze(t *testing.T) cutover.Snapshot {
	t.Helper()
	s, err := (legacy.Source{DB: f.source}).FreezeAndExport(ctx, "test-deployment")
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func (f *fixture) apply(t *testing.T, s cutover.Snapshot) {
	t.Helper()
	r, err := cutover.Apply(ctx, s, f.wallet, f.inventory)
	if err != nil || !r.WalletImported || !r.ItemsImported || r.APICutoverReady {
		t.Fatal(r, err)
	}
}

func TestFrozenBaselineAcrossThreeIndependentDatabases(t *testing.T) {
	f := setup(t)
	exec(t, f.source, `UPDATE wallet_balances SET value=value WHERE user_id='alice'`)
	s := f.freeze(t)
	if len(s.Items) != 2 || len(s.Balances) != 3 || len(s.Chests) != 1 {
		t.Fatal(s)
	}
	if !bytes.Contains(s.Chests[0].Record, []byte("9007199254740993")) {
		t.Fatal("large chest seed lost")
	}
	for _, q := range []string{
		`INSERT INTO inventory_items(id,user_id,item_id,state,origin) VALUES('new','alice','compass','intact','')`,
		`UPDATE inventory_items SET state='intact'`, `DELETE FROM inventory_items`, `TRUNCATE inventory_items`,
		`UPDATE wallet_balances SET value=0`, `DELETE FROM wallet_balances`, `TRUNCATE wallet_balances`,
		`UPDATE chest_instances SET status='opened'`, `DELETE FROM chest_instances`, `TRUNCATE chest_instances`,
		`UPDATE economy_owners SET starter_granted_at=now()`, `DELETE FROM economy_owners`,
	} {
		write, err := f.source.Begin()
		if err != nil {
			t.Fatal(err)
		}
		err = legacy.GuardWrite(ctx, write)
		if err == nil {
			_, err = write.Exec(q)
		}
		write.Rollback()
		if err == nil {
			t.Fatalf("frozen write accepted: %s", q)
		}
	}
	// Account display preferences are outside the frozen economy.
	exec(t, f.source, `SELECT id FROM economy_owners WHERE id='alice'`)
	other := f.freeze(t)
	a, _ := json.Marshal(s)
	b, _ := json.Marshal(other)
	if !bytes.Equal(a, b) {
		t.Fatal("retry changed snapshot")
	}
	if _, err := (legacy.Source{DB: f.source}).FreezeAndExport(ctx, "another-source"); err == nil {
		t.Fatal("changed source accepted")
	}
	f.apply(t, s)
	f.apply(t, s)
	if count(t, f.wdb, "ledger.journals") != 2 || count(t, f.wdb, "ledger.postings") != 4 || count(t, f.idb, "inventory.items") != 2 {
		t.Fatal("duplicated baseline")
	}
	for _, expected := range []struct {
		owner, asset string
		units        int64
	}{{"alice", "coins", 9007199254740993}, {"alice", "ore", 9}, {"bob", "coins", 0}} {
		b, err := wpg.New(f.wdb).Balance(ctx, expected.owner, expected.asset)
		if err != nil || b.Posted != expected.units || b.Held != 0 {
			t.Fatal(b, err)
		}
	}
	for _, pair := range []struct {
		db     *sql.DB
		schema string
	}{{f.wdb, "inventory"}, {f.idb, "wallet"}} {
		var exists bool
		if err := pair.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)`, pair.schema).Scan(&exists); err != nil || exists {
			t.Fatal("foreign context schema", err)
		}
	}
}

type lostWallet struct{ next wv1.OpeningClient }

func (c lostWallet) ImportOpening(ctx context.Context, in wv1.Opening) error {
	if err := c.next.ImportOpening(ctx, in); err != nil {
		return err
	}
	return errors.New("lost committed Wallet reply")
}

type lostInventory struct{ next iv1.OpeningClient }

func (c lostInventory) ImportItems(ctx context.Context, in iv1.Opening) error {
	if err := c.next.ImportItems(ctx, in); err != nil {
		return err
	}
	return errors.New("lost committed Inventory reply")
}

func TestImportResumesAfterEitherContextCommitsWithoutReply(t *testing.T) {
	f := setup(t)
	s := f.freeze(t)
	r, err := cutover.Apply(ctx, s, lostWallet{f.wallet}, f.inventory)
	if err == nil || r.WalletImported || count(t, f.wdb, "ledger.journals") != 2 || count(t, f.idb, "inventory.items") != 0 {
		t.Fatal(r, err)
	}
	// Reconstruct all target adapters, as on process restart.
	f.wallet, f.inventory = f.clients(t, []string{"coins", "ore"}, wdomain.OpeningBalance)
	r, err = cutover.Apply(ctx, s, f.wallet, lostInventory{f.inventory})
	if err == nil || !r.WalletImported || r.ItemsImported || count(t, f.idb, "inventory.items") != 2 {
		t.Fatal(r, err)
	}
	f.wallet, f.inventory = f.clients(t, []string{"coins", "ore"}, wdomain.OpeningBalance)
	f.apply(t, s)
	if count(t, f.wdb, "ledger.journals") != 2 {
		t.Fatal("duplicate opening money")
	}
}

func TestTamperingAndChangedBaselineCannotOverwriteTargets(t *testing.T) {
	f := setup(t)
	s := f.freeze(t)
	s.Balances[0].Units = "1"
	if _, err := cutover.Apply(ctx, s, f.wallet, f.inventory); err == nil || count(t, f.wdb, "ledger.journals") != 0 {
		t.Fatal("tampered snapshot applied", err)
	}
	s = f.freeze(t)
	f.apply(t, s)
	s.Balances[0].Units = "1"
	if err := s.Seal(); err != nil {
		t.Fatal(err)
	}
	if _, err := cutover.Apply(ctx, s, f.wallet, f.inventory); err == nil || count(t, f.wdb, "ledger.journals") != 2 {
		t.Fatal("different pinned baseline accepted", err)
	}
}

func TestOpeningCapabilityChecksAllAssetsBeforeWriting(t *testing.T) {
	f := setup(t)
	s := f.freeze(t)
	for _, scope := range []struct {
		assets  []string
		purpose wdomain.Purpose
	}{{[]string{"coins"}, wdomain.OpeningBalance}, {[]string{"coins", "ore"}, wdomain.Reward}} {
		w, i := f.clients(t, scope.assets, scope.purpose)
		if _, err := cutover.Apply(ctx, s, w, i); err == nil {
			t.Fatal("unauthorized opening accepted")
		}
		if count(t, f.wdb, "ledger.journals") != 0 || count(t, f.wdb, "ledger.opening_baseline") != 0 {
			t.Fatal("authorization failure partially wrote money")
		}
	}
	f.apply(t, s)
}

func TestLocalImportFailureRollsBackAndRecoversForward(t *testing.T) {
	f := setup(t)
	s := f.freeze(t)
	exec(t, f.wdb, `ALTER TABLE ledger.outbox ADD CONSTRAINT inject_failure CHECK(false) NOT VALID`)
	if _, err := cutover.Apply(ctx, s, f.wallet, f.inventory); err == nil {
		t.Fatal("injected Wallet failure ignored")
	}
	for _, table := range []string{"commands", "intents", "accounts", "journals", "postings", "outbox", "opening_baseline"} {
		if count(t, f.wdb, "ledger."+table) != 0 {
			t.Fatal("Wallet import partially committed", table)
		}
	}
	exec(t, f.wdb, `ALTER TABLE ledger.outbox DROP CONSTRAINT inject_failure`)
	exec(t, f.idb, `ALTER TABLE inventory.items ADD CONSTRAINT inject_failure CHECK(id<>'item-b') NOT VALID`)
	r, err := cutover.Apply(ctx, s, f.wallet, f.inventory)
	if err == nil || !r.WalletImported || count(t, f.idb, "inventory.items") != 0 || count(t, f.idb, "inventory.opening_baseline") != 0 {
		t.Fatal(r, err)
	}
	exec(t, f.idb, `ALTER TABLE inventory.items DROP CONSTRAINT inject_failure`)
	f.apply(t, s)
}

func TestImportRejectsNonemptyTargetsAndPostImportActivity(t *testing.T) {
	f := setup(t)
	s := f.freeze(t)
	exec(t, f.wdb, `INSERT INTO ledger.accounts(id,subject,asset,role) VALUES('existing','alice','coins','player_liability')`)
	if _, err := cutover.Apply(ctx, s, f.wallet, f.inventory); err == nil {
		t.Fatal("nonempty Wallet accepted")
	}
	exec(t, f.wdb, `DELETE FROM ledger.accounts WHERE id='existing'`)
	exec(t, f.idb, `INSERT INTO inventory.items(id,owner,definition,condition,origin,status) VALUES('existing','alice','lamp','intact','','available')`)
	if _, err := cutover.Apply(ctx, s, f.wallet, f.inventory); err == nil {
		t.Fatal("nonempty Inventory accepted")
	}
	// Retained instances cannot be deleted to make an occupied target look empty.
	f = setup(t)
	s = f.freeze(t)
	f.apply(t, s)
	exec(t, f.idb, `UPDATE inventory.items SET condition='slight' WHERE id='item-a'`)
	if _, err := cutover.Apply(ctx, s, f.wallet, f.inventory); err == nil {
		t.Fatal("Inventory drift accepted as imported baseline")
	}
	exec(t, f.idb, `UPDATE inventory.items SET condition='heavy' WHERE id='item-a'`)
	policy, err := authorization.New([]authorization.Grant{{Producer: "inventory", Actions: []wdomain.Action{wdomain.Reserve}, Assets: []string{"coins"}, AllSubjects: true, Purposes: []wdomain.Purpose{wdomain.Spending}}})
	if err != nil {
		t.Fatal(err)
	}
	service, err := wallet.New(wpg.New(f.wdb), policy, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Execute(ctx, wallet.Command{Producer: "inventory", ID: "reserve", IntentID: "reserve", Action: wdomain.Reserve, Terms: &wdomain.Terms{Subject: "alice", Asset: "coins", Units: 1, Purpose: wdomain.Spending, Evidence: "quote"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := cutover.Apply(ctx, s, f.wallet, f.inventory); err == nil {
		t.Fatal("Wallet activity accepted as imported baseline")
	}
}

func TestConcurrentIdenticalImportsHaveOneEffect(t *testing.T) {
	f := setup(t)
	s := f.freeze(t)
	var wg sync.WaitGroup
	errs := make(chan error, 6)
	for range 6 {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := cutover.Apply(ctx, s, f.wallet, f.inventory); errs <- err }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if count(t, f.wdb, "ledger.journals") != 2 || count(t, f.idb, "inventory.items") != 2 {
		t.Fatal("concurrent imports duplicated effects")
	}
}

func TestFreezeIncludesInflightCommittedWriter(t *testing.T) {
	f := setup(t)
	tx, err := f.source.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE wallet_balances SET value=101 WHERE user_id='alice' AND resource='coins'`); err != nil {
		t.Fatal(err)
	}
	deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	type result struct {
		s   cutover.Snapshot
		err error
	}
	done := make(chan result, 1)
	go func() {
		s, err := (legacy.Source{DB: f.source}).FreezeAndExport(deadline, "test-deployment")
		done <- result{s, err}
	}()
	// Observe an actual lock wait rather than relying on a scheduling delay.
	for {
		var waiting bool
		if err = f.source.QueryRowContext(deadline, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation='public.wallet_balances'::regclass AND NOT granted)`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case r := <-done:
			t.Fatal("freeze did not wait for writer", r.err)
		case <-deadline.Done():
			t.Fatal(deadline.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	r := <-done
	if r.err != nil {
		t.Fatal(r.err)
	}
	for _, b := range r.s.Balances {
		if b.Subject == "alice" && b.Asset == "coins" && b.Units != "101" {
			t.Fatal("writer omitted from snapshot", b)
		}
	}
}

func TestOldRepeatableReadSnapshotCannotBypassFreeze(t *testing.T) {
	f := setup(t)
	tx, err := f.source.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var stopped bool
	if err = tx.QueryRow(`SELECT frozen FROM legacy_economy_cutover.snapshot`).Scan(&stopped); err != nil || stopped {
		t.Fatal(stopped, err)
	}
	f.freeze(t)
	if err = legacy.GuardWrite(ctx, tx); err == nil {
		t.Fatal("old snapshot bypassed barrier")
	}
}

func TestInvalidLegacyDataDoesNotFreezeOrPartiallyExport(t *testing.T) {
	f := setup(t)
	exec(t, f.source, `UPDATE inventory_items SET state='unknown' WHERE id='item-a'`)
	if _, err := (legacy.Source{DB: f.source}).FreezeAndExport(ctx, "test-deployment"); err == nil {
		t.Fatal("invalid legacy condition accepted")
	}
	var frozen bool
	if err := f.source.QueryRow(`SELECT frozen FROM legacy_economy_cutover.snapshot`).Scan(&frozen); err != nil || frozen {
		t.Fatal("failed export froze source", frozen, err)
	}
	exec(t, f.source, `UPDATE inventory_items SET state='heavy' WHERE id='item-a'`)
	f.apply(t, f.freeze(t))
}

func TestEmptyBaselineIsPinnedWithoutZeroPostings(t *testing.T) {
	f := setup(t)
	exec(t, f.source, `DELETE FROM inventory_items; DELETE FROM chest_instances; DELETE FROM wallet_balances`)
	s := f.freeze(t)
	f.apply(t, s)
	f.apply(t, s)
	if count(t, f.wdb, "ledger.journals") != 0 || count(t, f.wdb, "ledger.opening_baseline") != 1 || count(t, f.idb, "inventory.opening_baseline") != 1 {
		t.Fatal("empty baseline was not pinned")
	}
}
