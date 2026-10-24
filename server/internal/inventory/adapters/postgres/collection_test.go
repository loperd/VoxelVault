package postgres_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	pg "github.com/voxel-vault/api/internal/inventory/adapters/postgres"
	"github.com/voxel-vault/api/internal/inventory/adapters/postgres/migrations"
	"github.com/voxel-vault/api/internal/inventory/application"
	"github.com/voxel-vault/api/internal/inventory/domain"
	"github.com/voxel-vault/api/internal/inventory/domain/chest"
	"github.com/voxel-vault/api/internal/inventory/domain/rulebook"
	"github.com/voxel-vault/api/internal/inventory/domain/rulebook/rulebooktest"
)

var serial atomic.Uint64
var ctx = application.WithAuthenticatedPrincipal(context.Background(), application.Principal{Kind: "operator", ID: "test-fixture"})

type fixture struct {
	db      *sql.DB
	store   *pg.Store
	service application.CollectionService
	rb      *rulebook.Rulebook
	rolls   atomic.Uint64
}

func (f *fixture) checkpoint(t *testing.T) {
	t.Helper()
	tx, err := f.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err = pg.BootstrapLifecycle(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func stack(t *testing.T) *fixture {
	return stackAt(t, 0)
}

func stackAt(t *testing.T, version int64) *fixture {
	t.Helper()
	dsn := os.Getenv("TEST_WALLET_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_WALLET_DATABASE_URL is required for independent disposable Inventory databases")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("collection_test_%d_%d", os.Getpid(), serial.Add(1))
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
	db.SetMaxOpenConns(24)
	t.Cleanup(func() {
		db.Close()
		if _, err := admin.Exec(`DROP DATABASE ` + name + ` WITH(FORCE)`); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	if version == 0 {
		err = migrations.Up(ctx, db)
	} else {
		var provider *goose.Provider
		provider, err = migrations.Provider(db)
		if err == nil {
			_, err = provider.UpTo(ctx, version)
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{db: db, store: pg.New(db), rb: rulebooktest.Build(t, rulebooktest.Set(map[string]float64{"chest.destroy.impact.perWear": 0, "chest.destroy.opening.perWear": 0}))}
	f.service = application.CollectionService{Authorizer: allowInventory{}, StarterPolicy: func([]application.Grant) bool { return true }, Store: f.store, Rulebook: func() *rulebook.Rulebook { return f.rb }, Clock: time.Now, Seed: func() (uint64, error) { return f.rolls.Add(1), nil }}
	return f
}
func (f *fixture) issue(t *testing.T, request string, n int) []domain.StoredChest {
	t.Helper()
	cs, err := f.service.Issue(ctx, application.IssueRequest{Owner: "player", RequestID: request, Type: "ender", Source: "admin", Count: n})
	if err != nil {
		t.Fatal(err)
	}
	return cs
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
	if err := db.QueryRow(`SELECT count(*) FROM inventory.` + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestStarterAndAdministrativeIssuanceAreDurableAndIdempotent(t *testing.T) {
	f := stack(t)
	var wg sync.WaitGroup
	errs := make(chan error, 12)
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- f.service.GrantStarter(ctx, "player", []application.Grant{{Type: "ender", Count: 2}})
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if count(t, f.db, "chests") != 2 || f.rolls.Load() != 2 {
		t.Fatal("duplicate starter grant")
	}
	a := f.issue(t, "admin-request", 2)
	b := f.issue(t, "admin-request", 2)
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	if string(x) != string(y) || f.rolls.Load() != 4 {
		t.Fatal("administrative retry changed its outcome")
	}
	restarted := f.service
	restarted.Seed = func() (uint64, error) { return 0, errors.New("a replay must not roll a new seed") }
	if _, err := restarted.Issue(ctx, application.IssueRequest{Owner: "player", RequestID: "admin-request", Type: "ender", Source: "admin", Count: 2}); err != nil {
		t.Fatal("stored issuance did not survive service restart", err)
	}
	if _, err := f.service.Issue(ctx, application.IssueRequest{Owner: "player", RequestID: "admin-request", Type: "ender", Source: "admin", Count: 1}); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("changed request accepted", err)
	}
	if err := f.service.GrantStarter(ctx, "player", []application.Grant{{Type: "ender", Count: 3}}); err != nil {
		t.Fatal(err)
	}
	if count(t, f.db, "chests") != 4 {
		t.Fatal("configuration change granted starters twice")
	}
	var foreign bool
	if err := f.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='wallet')`).Scan(&foreign); err != nil || foreign {
		t.Fatal("Inventory requires Wallet schema", err)
	}
}

func TestOpeningKeepsItsHistoricalReceiptAfterWorkshopConsumption(t *testing.T) {
	f := stack(t)
	id := f.issue(t, "issue", 1)[0].State.ID
	if _, _, err := f.service.Claim(ctx, "other", id, "session"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal(err)
	}
	first, landing, err := f.service.Claim(ctx, "player", id, "session")
	if err != nil || landing == nil || first.State.Status != chest.Opening {
		t.Fatal(first, landing, err)
	}
	again, landing, err := f.service.Claim(ctx, "player", id, "session")
	if err != nil || landing != nil || !reflect.DeepEqual(first, again) {
		t.Fatal("claim was rolled twice", err)
	}
	if _, err = f.service.Open(ctx, "player", id, "wrong"); !errors.Is(err, chest.ErrWrongSession) {
		t.Fatal(err)
	}
	opened, err := f.service.Open(ctx, "player", id, "session")
	if err != nil || opened.Reward == nil || opened.OpenedAt == nil {
		t.Fatal(opened, err)
	}
	workshop, err := application.New(f.store, fixedPrice{}, allowInventory{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = workshop.Start(ctx, application.Request{Owner: "player", RequestID: "sell", ItemID: opened.Reward.ID, Action: domain.Sell}); err != nil {
		t.Fatal(err)
	}
	retried, err := f.service.Open(ctx, "player", id, "session")
	if err != nil || !reflect.DeepEqual(opened, retried) {
		t.Fatal("retry changed historical opening", err)
	}
	items, err := f.store.Items(ctx, "player")
	if err != nil || len(items) != 0 || count(t, f.db, "items") != 1 {
		t.Fatal("consumed reward was minted again", items, err)
	}
}

type fixedPrice struct{}

func (fixedPrice) Quote(domain.Item, domain.Action) (domain.Quote, error) {
	return domain.Quote{Asset: "coins", Units: 1, Revision: "v1"}, nil
}

func TestOpeningTransactionRollsBackDropWhenChestSaveFails(t *testing.T) {
	f := stack(t)
	id := f.issue(t, "issue", 1)[0].State.ID
	if _, _, err := f.service.Claim(ctx, "player", id, "session"); err != nil {
		t.Fatal(err)
	}
	exec(t, f.db, `ALTER TABLE inventory.chests ADD CONSTRAINT reject_open CHECK(body#>>'{State,Status}'<>'opened') NOT VALID`)
	if _, err := f.service.Open(ctx, "player", id, "session"); err == nil {
		t.Fatal("injected failure ignored")
	}
	if count(t, f.db, "items") != 0 {
		t.Fatal("reward survived failed chest save")
	}
	exec(t, f.db, `ALTER TABLE inventory.chests DROP CONSTRAINT reject_open`)
	opened, err := f.service.Open(ctx, "player", id, "session")
	if err != nil || opened.Reward == nil || count(t, f.db, "items") != 1 {
		t.Fatal(opened, err)
	}
}

func TestConcurrentOpenRequestsReceiveOneDrop(t *testing.T) {
	f := stack(t)
	id := f.issue(t, "issue", 1)[0].State.ID
	if _, _, err := f.service.Claim(ctx, "player", id, "session"); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan domain.StoredChest, 12)
	errs := make(chan error, 12)
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := f.service.Open(ctx, "player", id, "session")
			results <- r
			errs <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	idSeen := ""
	for r := range results {
		if r.Reward == nil {
			t.Fatal(r)
		}
		if idSeen != "" && r.Reward.ID != idSeen {
			t.Fatal("multiple rewards")
		}
		idSeen = r.Reward.ID
	}
	if count(t, f.db, "items") != 1 {
		t.Fatal("opening duplicated items")
	}
	verifyHistory(t, f)
}

func TestChestMergeRetriesAndConcurrentConflicts(t *testing.T) {
	f := stack(t)
	cs := f.issue(t, "issue", 2)
	pair := application.PairRequest{Owner: "player", RequestID: "merge", A: cs[0].State.ID, B: cs[1].State.ID}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	results := make(chan domain.StoredChest, 2)
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); r, err := f.service.MergeChests(ctx, pair); results <- r; errs <- err }()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var merged domain.StoredChest
	for r := range results {
		if merged.State.ID != "" && merged.State.ID != r.State.ID {
			t.Fatal("different merged results")
		}
		merged = r
	}
	if count(t, f.db, "chests") != 3 {
		t.Fatal("merge created multiple children")
	}
	if _, _, err := f.service.Claim(ctx, "player", merged.State.ID, "session"); err != nil {
		t.Fatal(err)
	}
	again, err := f.service.MergeChests(ctx, pair)
	if err != nil || !reflect.DeepEqual(merged, again) {
		t.Fatal("merge retry changed its receipt", err)
	}
	pair.RequestID = "another-merge"
	if _, err = f.service.MergeChests(ctx, pair); !errors.Is(err, chest.ErrUnavailable) {
		t.Fatal("spent parents merged twice", err)
	}
}

func TestItemMergeCompetesWithWorkshopReservation(t *testing.T) {
	f := stack(t)
	workshop, err := application.New(f.store, fixedPrice{}, allowInventory{})
	if err != nil {
		t.Fatal(err)
	}
	for i := range 12 {
		a, b := fmt.Sprintf("item-a-%d", i), fmt.Sprintf("item-b-%d", i)
		exec(t, f.db, `INSERT INTO inventory.items(id,owner,definition,condition,origin,status) VALUES($1,'player','item-a','heavy','','available'),($2,'player','item-a','broken','','available')`, a, b)
		f.checkpoint(t)
		start := make(chan struct{})
		mergeErr := make(chan error, 1)
		workErr := make(chan error, 1)
		go func() {
			<-start
			_, err := f.service.MergeItems(ctx, application.PairRequest{Owner: "player", RequestID: fmt.Sprintf("merge-%d", i), A: a, B: b})
			mergeErr <- err
		}()
		go func() {
			<-start
			_, err := workshop.Start(ctx, application.Request{Owner: "player", RequestID: fmt.Sprintf("work-%d", i), ItemID: b, Action: domain.Repair})
			workErr <- err
		}()
		close(start)
		m, w := <-mergeErr, <-workErr
		if (m == nil) == (w == nil) {
			t.Fatal("exactly one competing action must succeed", m, w)
		}
		if m != nil && !errors.Is(m, domain.ErrBusy) {
			t.Fatal(m)
		}
		if w != nil && !errors.Is(w, domain.ErrBusy) {
			t.Fatal(w)
		}
		if m == nil {
			replayed, err := f.service.MergeItems(ctx, application.PairRequest{Owner: "player", RequestID: fmt.Sprintf("merge-%d", i), A: a, B: b})
			if err != nil || replayed.ID != a {
				t.Fatal(replayed, err)
			}
		}
	}
}

func TestFailedStarterGrantDoesNotMarkOrPartiallyIssue(t *testing.T) {
	f := stack(t)
	err := f.service.GrantStarter(ctx, "player", []application.Grant{{Type: "ender", Count: 1}, {Type: "unknown", Count: 1}})
	if err == nil || count(t, f.db, "chests") != 0 || count(t, f.db, "owners") != 0 {
		t.Fatal("partial starter grant", err)
	}
	if err = f.service.GrantStarter(ctx, "player", []application.Grant{{Type: "ender", Count: 1}}); err != nil || count(t, f.db, "chests") != 1 {
		t.Fatal(err)
	}
}

func TestDestroyedChestNeverReceivesAnItem(t *testing.T) {
	for _, moment := range []string{"impact", "opening"} {
		t.Run(moment, func(t *testing.T) {
			f := stack(t)
			f.rb = rulebooktest.Build(t, rulebooktest.Set(map[string]float64{"landing.damage.chance": 0, "chest.destroy.impact.perWear": 0, "chest.destroy.opening.perWear": 0, "chest.destroy." + moment + ".perWear": 1}))
			id := f.issue(t, "issue", 1)[0].State.ID
			if err := f.store.Collection(ctx, func(tx application.CollectionTx) error {
				c, err := tx.Chest("player", id)
				if err != nil {
					return err
				}
				c.State.Condition = 0
				return tx.SaveChest(c)
			}); err != nil {
				t.Fatal(err)
			}
			if _, _, err := f.service.Claim(ctx, "player", id, "session"); err != nil {
				t.Fatal(err)
			}
			opened, err := f.service.Open(ctx, "player", id, "session")
			if err != nil || opened.State.Status != chest.Destroyed || string(opened.State.DestroyedAt) != moment || opened.Reward != nil || count(t, f.db, "items") != 0 {
				t.Fatal(opened, err)
			}
			if _, err = f.service.Open(ctx, "player", id, "session"); err != nil {
				t.Fatal("destroyed opening retry", err)
			}
		})
	}
}
