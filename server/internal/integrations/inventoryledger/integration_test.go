package inventoryledger_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	bridge "github.com/voxel-vault/api/internal/integrations/inventoryledger"
	ipg "github.com/voxel-vault/api/inventory/adapters/postgres"
	imigrate "github.com/voxel-vault/api/inventory/adapters/postgres/migrations"
	inv "github.com/voxel-vault/api/inventory/application"
	idomain "github.com/voxel-vault/api/inventory/domain"
	"github.com/voxel-vault/api/ledger/adapters/authorization"
	"github.com/voxel-vault/api/ledger/adapters/inbound/local"
	"github.com/voxel-vault/api/ledger/adapters/outbound/events"
	wpg "github.com/voxel-vault/api/ledger/adapters/postgres"
	wmigrate "github.com/voxel-vault/api/ledger/adapters/postgres/migrations"
	wallet "github.com/voxel-vault/api/ledger/application"
	v1 "github.com/voxel-vault/api/ledger/contracts/v1"
	wdomain "github.com/voxel-vault/api/ledger/domain"
)

var ctx = inv.WithAuthenticatedPrincipal(context.Background(), inv.Principal{Kind: "operator", ID: "test-fixture"})
var seq atomic.Uint64

func database(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("TEST_WALLET_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_WALLET_DATABASE_URL is required; integration uses separate disposable databases")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("saga_test_%d_%d", os.Getpid(), seq.Add(1))
	if _, err := admin.Exec(`CREATE DATABASE ` + name); err != nil {
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
	db.SetMaxOpenConns(20)
	t.Cleanup(func() {
		db.Close()
		if _, err := admin.Exec(`DROP DATABASE ` + name + ` WITH(FORCE)`); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	return db
}

type pricing struct{ units int64 }

func (p pricing) Quote(_ idomain.Item, _ idomain.Action) (idomain.Quote, error) {
	return idomain.Quote{Asset: "coins", Units: p.units, Revision: "rules-v1"}, nil
}

type fixture struct {
	idb, wdb         *sql.DB
	inventory        *inv.Service
	is               *ipg.Store
	ws               *wpg.Store
	wallet           *wallet.Service
	client, treasury *local.Client
	now              time.Time
}

func stack(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{idb: database(t), wdb: database(t), now: time.Now().UTC().Add(time.Hour)}
	if err := imigrate.Up(ctx, f.idb); err != nil {
		t.Fatal(err)
	}
	if err := wmigrate.Up(ctx, f.wdb); err != nil {
		t.Fatal(err)
	}
	f.is = ipg.New(f.idb)
	f.ws = wpg.New(f.wdb)
	policy, err := authorization.New([]authorization.Grant{
		{Producer: "inventory", Actions: []wdomain.Action{wdomain.Reserve, wdomain.Capture, wdomain.Cancel, wdomain.Credit, wdomain.Close, wdomain.Payout, wdomain.ClosePayout, wallet.ReadCapability}, Assets: []string{"coins"}, Subjects: []string{"player"}, Purposes: []wdomain.Purpose{wdomain.Spending, wdomain.Reward, wdomain.Buyback}, Treasuries: []string{bridge.DefaultBuybackTreasury}},
		{Producer: "treasury", Actions: []wdomain.Action{wdomain.Credit}, Assets: []string{"coins"}, Subjects: []string{"player"}, Purposes: []wdomain.Purpose{wdomain.OpeningBalance}},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.wallet, err = wallet.New(f.ws, policy, func() time.Time { return f.now })
	if err != nil {
		t.Fatal(err)
	}
	f.client, err = local.New(f.wallet, "inventory")
	if err != nil {
		t.Fatal(err)
	}
	f.treasury, err = local.New(f.wallet, "treasury")
	if err != nil {
		t.Fatal(err)
	}
	f.inventory, err = inv.New(f.is, pricing{8}, allowInventory{})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"item-a", "item-b"} {
		if _, err := f.idb.Exec(`INSERT INTO inventory.items(id,owner,definition,condition,origin,status) VALUES($1,'player','compass','heavy','opening-1','available')`, id); err != nil {
			t.Fatal(err)
		}
	}
	f.checkpoint(t)
	f.openBuyback(t, 1000)
	return f
}

func (f *fixture) openBuyback(t *testing.T, units int64) {
	t.Helper()
	p, err := authorization.New([]authorization.Grant{{Producer: "test-funding", Actions: []wdomain.Action{wdomain.FundTreasury}, MaxUnits: units, Assets: []string{"coins"}, Subjects: []string{"system"}, Purposes: []wdomain.Purpose{wdomain.TreasuryOpening}, Treasuries: []string{bridge.DefaultBuybackTreasury}}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = (wallet.TreasuryOpeningService{Store: f.ws, Authorizer: allowIssuance{p}, Producer: "test-funding", Clock: func() time.Time { return f.now }}).Open(ctx, wallet.TreasuryOpening{Treasury: bridge.DefaultBuybackTreasury, Asset: "coins", Units: units, Source: "fixture", Reference: "budget"})
	if err != nil {
		t.Fatal(err)
	}
}
func (f *fixture) seed(t *testing.T, units int64) {
	t.Helper()
	_, err := f.treasury.Execute(ctx, v1.Command{ID: "opening", IntentID: "opening", Action: "credit", Terms: &v1.Terms{Subject: "player", Asset: "coins", Units: strconv.FormatInt(units, 10), Purpose: "opening_balance", Evidence: "legacy-opening"}})
	if err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) checkpoint(t *testing.T) {
	t.Helper()
	tx, err := f.idb.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err = ipg.BootstrapLifecycle(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
}
func (f *fixture) start(t *testing.T, request, item string, action idomain.Action) idomain.Operation {
	t.Helper()
	f.checkpoint(t)
	op, err := f.inventory.Start(ctx, inv.Request{Owner: "player", RequestID: request, ItemID: item, Action: action})
	if err != nil {
		t.Fatal(err)
	}
	return op
}
func (f *fixture) worker(client v1.Client) inv.Worker {
	return inv.Worker{Store: f.is, Authorizer: allowInventory{}, Settlement: bridge.Settlement{Client: client, Treasury: bridge.DefaultBuybackTreasury}, Service: f.inventory, Owner: "worker", Clock: func() time.Time { return f.now }, Lease: time.Minute, Limit: 32}
}
func (f *fixture) dispatch() wallet.Dispatcher {
	scoped, err := f.ws.EventsFor("inventory")
	if err != nil {
		panic(err)
	}
	return wallet.Dispatcher{Store: scoped, Publisher: events.Publisher{Sink: bridge.Receiver{Service: f.inventory, Principal: inv.Principal{Kind: "service", ID: "test-wallet-events"}, Producer: "inventory", Treasury: bridge.DefaultBuybackTreasury}}, Owner: "wallet-worker", Clock: func() time.Time { return f.now }, Lease: time.Minute, Limit: 32}
}
func (f *fixture) operation(t *testing.T, id string) idomain.Operation {
	t.Helper()
	op, err := f.inventory.Operation(ctx, "player", id)
	if err != nil {
		t.Fatal(err)
	}
	return op
}
func (f *fixture) item(t *testing.T, id string) (condition, status string) {
	t.Helper()
	if err := f.idb.QueryRow(`SELECT condition,status FROM inventory.items WHERE id=$1`, id).Scan(&condition, &status); err != nil {
		t.Fatal(err)
	}
	return
}
func (f *fixture) balance(t *testing.T, posted, held int64) {
	t.Helper()
	b, err := f.ws.Balance(ctx, "player", "coins")
	if err != nil || b.Posted != posted || b.Held != held {
		t.Fatal(b, err, "want", posted, held)
	}
}
func (f *fixture) drain(t *testing.T) {
	t.Helper()
	for range 8 {
		stats, err := f.worker(f.client).RunOnce(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if stats.Claimed == 0 {
			return
		}
	}
	t.Fatal("work did not converge")
}
func (f *fixture) playerJournalCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.wdb.QueryRow(`SELECT count(*) FROM ledger.journals j JOIN ledger.intents i ON i.producer=j.producer AND i.id=j.intent_id WHERE i.body#>>'{Terms,Purpose}'<>'treasury_opening'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRepairAcrossIndependentDatabasesAndDuplicateEvents(t *testing.T) {
	f := stack(t)
	f.seed(t, 10)
	op := f.start(t, "repair", "item-a", idomain.Repair)
	if op.Stage != idomain.AwaitFunds {
		t.Fatal(op)
	}
	if _, err := f.worker(f.client).RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if condition, status := f.item(t, "item-a"); condition != "slight" || status != idomain.Locked {
		t.Fatal(condition, status)
	}
	f.balance(t, 10, 8)
	if _, err := f.inventory.Cancel(ctx, "player", op.ID); !errors.Is(err, idomain.ErrConflict) {
		t.Fatal("cancel after repair commit", err)
	}
	f.drain(t)
	f.balance(t, 2, 0)
	if condition, status := f.item(t, "item-a"); condition != "slight" || status != idomain.Available {
		t.Fatal(condition, status)
	}
	completed := f.operation(t, op.ID)
	if completed.Stage != idomain.Completed {
		t.Fatal(completed)
	}
	if _, err := f.dispatch().RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if latest := f.operation(t, op.ID); latest.Version != completed.Version {
		t.Fatal("duplicate events changed operation", latest)
	}
	again := f.start(t, "repair", "item-a", idomain.Repair)
	if again.ID != op.ID || again.Stage != idomain.Completed {
		t.Fatal(again)
	}
	if f.playerJournalCount(t) != 2 {
		t.Fatal("duplicate debit")
	}
	var foreign bool
	if err := f.idb.QueryRow(`SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name='wallet')`).Scan(&foreign); err != nil || foreign {
		t.Fatal("inventory has wallet schema", err)
	}
	if err := f.wdb.QueryRow(`SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name='inventory')`).Scan(&foreign); err != nil || foreign {
		t.Fatal("wallet has inventory schema", err)
	}
}

type lostReply struct {
	v1.Client
	action string
	lost   bool
}

func (c *lostReply) Execute(ctx context.Context, cmd v1.Command) (v1.Receipt, error) {
	r, err := c.Client.Execute(ctx, cmd)
	if err == nil && cmd.Action == c.action && !c.lost {
		c.lost = true
		return v1.Receipt{}, &v1.Error{Code: v1.Unavailable}
	}
	return r, err
}
func TestLostCaptureReplyRecoversFromWalletOutbox(t *testing.T) {
	f := stack(t)
	f.seed(t, 10)
	op := f.start(t, "repair", "item-a", idomain.Repair)
	if _, err := f.worker(f.client).RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	broken := &lostReply{Client: f.client, action: "capture"}
	if _, err := f.worker(broken).RunOnce(ctx); err == nil {
		t.Fatal("lost reply not simulated")
	}
	f.balance(t, 2, 0)
	if f.operation(t, op.ID).Stage != idomain.RepairCommitted {
		t.Fatal("premature completion")
	}
	// Reconstruct stateless services/repositories; the durable facts complete the locked item.
	var err error
	f.inventory, err = inv.New(ipg.New(f.idb), pricing{99}, allowInventory{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.dispatch().RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if f.operation(t, op.ID).Stage != idomain.Completed {
		t.Fatal("event recovery did not complete")
	}
	f.now = f.now.Add(4 * time.Second)
	f.drain(t)
	f.balance(t, 2, 0)
	if f.playerJournalCount(t) != 2 {
		t.Fatal("retry charged twice")
	}
}
func TestCancelBeforeReserveDeliveryAndStaleLease(t *testing.T) {
	f := stack(t)
	f.seed(t, 10)
	op := f.start(t, "repair", "item-a", idomain.Repair)
	first, err := f.is.ClaimJobs(ctx, "crashed", f.now, time.Second, 32)
	if err != nil || len(first) != 1 {
		t.Fatal(first, err)
	}
	if _, err := f.inventory.Cancel(ctx, "player", op.ID); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(2 * time.Second)
	jobs, err := f.is.ClaimJobs(ctx, "replacement", f.now, time.Minute, 32)
	if err != nil || len(jobs) != 2 {
		t.Fatal(len(jobs), err)
	}
	if err := f.is.FinishJob(ctx, first[0].Command.ID, "crashed", first[0].Fence, f.now, ""); !errors.Is(err, inv.ErrLeaseLost) {
		t.Fatal("stale worker acknowledged", err)
	}
	// Intentionally deliver cancellation before the earlier reserve message.
	for _, step := range []idomain.Step{idomain.CancelCost, idomain.ReserveCost} {
		for _, job := range jobs {
			if job.Command.Step != step {
				continue
			}
			fact, err := (bridge.Settlement{Client: f.client, Treasury: bridge.DefaultBuybackTreasury}).Execute(ctx, job.Command)
			if err != nil {
				t.Fatal(err)
			}
			if err := f.inventory.Observe(ctx, idomain.Identity("reply", job.Command.ID), fact); err != nil {
				t.Fatal(err)
			}
			if err := f.is.FinishJob(ctx, job.Command.ID, "replacement", job.Fence, f.now, ""); err != nil {
				t.Fatal(err)
			}
		}
	}
	if f.operation(t, op.ID).Stage != idomain.Canceled {
		t.Fatal("cancellation not completed")
	}
	f.balance(t, 10, 0)
	if condition, status := f.item(t, "item-a"); condition != "heavy" || status != idomain.Available {
		t.Fatal(condition, status)
	}
	if _, err := f.dispatch().RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
}
func TestLostAwardReplyAndRepeatedTransportDoNotDuplicateCredit(t *testing.T) {
	f := stack(t)
	op := f.start(t, "sale", "item-a", idomain.Sell)
	broken := &lostReply{Client: f.client, action: "payout"}
	if _, err := f.worker(broken).RunOnce(ctx); err == nil {
		t.Fatal("lost reply not simulated")
	}
	f.balance(t, 8, 0)
	if f.operation(t, op.ID).Stage != idomain.AwaitAward {
		t.Fatal("lost reply should stay pending")
	}
	f.now = f.now.Add(4 * time.Second)
	f.drain(t)
	if f.operation(t, op.ID).Stage != idomain.Completed {
		t.Fatal("sale did not finish")
	}
	if _, err := f.dispatch().RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	f.balance(t, 8, 0)
	if f.playerJournalCount(t) != 1 {
		t.Fatal("award duplicated")
	}
	if _, status := f.item(t, "item-a"); status != idomain.Consumed {
		t.Fatal(status)
	}
}
func TestRejectedAwardRestoresOnlyAfterClosure(t *testing.T) {
	f := stack(t)
	f.seed(t, math.MaxInt64)
	op := f.start(t, "sale", "item-a", idomain.Sell)
	if _, err := f.worker(f.client).RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if f.operation(t, op.ID).Stage != idomain.Closing {
		t.Fatal("award rejection was not fenced")
	}
	if _, status := f.item(t, "item-a"); status != idomain.Consumed {
		t.Fatal("item restored without terminal proof")
	}
	f.drain(t)
	if f.operation(t, op.ID).Stage != idomain.Restored {
		t.Fatal("closed award was not compensated")
	}
	f.balance(t, math.MaxInt64, 0)
	if f.playerJournalCount(t) != 1 {
		t.Fatal("rejected award posted")
	}
	if condition, status := f.item(t, "item-a"); condition != "heavy" || status != idomain.Available {
		t.Fatal(condition, status)
	}
	if _, err := f.dispatch().RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
}
func TestConcurrentActionsOnOneItemAndChangedRequestConflict(t *testing.T) {
	f := stack(t)
	start := make(chan struct{})
	errs := make(chan error, 12)
	var wg sync.WaitGroup
	for n := range 12 {
		wg.Go(func() {
			<-start
			_, err := f.inventory.Start(ctx, inv.Request{Owner: "player", RequestID: fmt.Sprint("sale-", n), ItemID: "item-a", Action: idomain.Sell})
			errs <- err
		})
	}
	close(start)
	wg.Wait()
	close(errs)
	accepted := 0
	for err := range errs {
		if err == nil {
			accepted++
		} else if !errors.Is(err, idomain.ErrBusy) {
			t.Fatal(err)
		}
	}
	if accepted != 1 {
		t.Fatal("accepted conflicting actions", accepted)
	}
	f.drain(t)
	f.balance(t, 8, 0)
	if f.playerJournalCount(t) != 1 {
		t.Fatal("item sold twice")
	}
	op := f.start(t, "another", "item-b", idomain.Sell)
	if _, err := f.inventory.Start(ctx, inv.Request{Owner: "player", RequestID: "another", ItemID: "item-b", Action: idomain.Salvage}); !errors.Is(err, idomain.ErrConflict) {
		t.Fatal("idempotency key changed action", err)
	}
	if _, err := f.inventory.Cancel(ctx, "another-player", op.ID); !errors.Is(err, idomain.ErrNotFound) {
		t.Fatal("owner boundary", err)
	}
}
func TestWalletDeliveryLeaseFencingAndInboxPayloadConflict(t *testing.T) {
	f := stack(t)
	op := f.start(t, "sale", "item-a", idomain.Sell)
	f.drain(t)
	batch, err := f.ws.ClaimEvents(ctx, "crashed", f.now, time.Second, 32)
	if err != nil || len(batch) != 1 {
		t.Fatal(batch, err)
	}
	f.now = f.now.Add(2 * time.Second)
	replacement, err := f.ws.ClaimEvents(ctx, "new", f.now, time.Minute, 32)
	if err != nil || len(replacement) != 1 {
		t.Fatal(replacement, err)
	}
	if err := f.ws.AckEvent(ctx, batch[0].Event.ID, "crashed", batch[0].Fence, f.now); !errors.Is(err, wallet.ErrLeaseLost) {
		t.Fatal(err)
	}
	sink := bridge.Receiver{Service: f.inventory, Principal: inv.Principal{Kind: "service", ID: "test-wallet-events"}, Producer: "inventory", Treasury: bridge.DefaultBuybackTreasury}
	publication := events.Publisher{Sink: sink}
	if err := publication.Publish(ctx, replacement[0].Event); err != nil {
		t.Fatal(err)
	}
	if err := publication.Publish(ctx, replacement[0].Event); err != nil {
		t.Fatal("duplicate event", err)
	}
	if err := f.ws.AckEvent(ctx, replacement[0].Event.ID, "new", replacement[0].Fence, f.now); err != nil {
		t.Fatal(err)
	}
	receipt, err := f.client.Status(ctx, op.ID)
	if err != nil {
		t.Fatal(err)
	}
	event := v1.Event{Version: 1, ID: "stable-message", CorrelationID: op.ID, Producer: "inventory", Receipt: receipt}
	if err := sink.Deliver(ctx, event); err != nil {
		t.Fatal(err)
	}
	event.Receipt.Reason = "changed provider reason"
	// A meaningful changed payload under an existing inbox ID must conflict.
	event.Receipt.Version++
	if err := sink.Deliver(ctx, event); !errors.Is(err, idomain.ErrConflict) {
		t.Fatal("inbox identity accepted changed fact", err)
	}
}
func TestPublishedAmountsAndProducerCapabilities(t *testing.T) {
	f := stack(t)
	f.seed(t, 9007199254740993)
	balance, err := f.client.Balance(ctx, "player", "coins")
	if err != nil || balance.Posted != "9007199254740993" {
		t.Fatal(balance, err)
	}
	raw, err := json.Marshal(balance)
	if err != nil {
		t.Fatal(err)
	}
	var values map[string]string
	if err := json.Unmarshal(raw, &values); err != nil {
		t.Fatal("numeric amount escaped the public contract", string(raw))
	}
	_, err = f.client.Execute(ctx, v1.Command{ID: "fake-opening", IntentID: "fake-opening", Action: "credit", Terms: &v1.Terms{Subject: "player", Asset: "coins", Units: "1", Purpose: "opening_balance", Evidence: "bad"}})
	var failure *v1.Error
	if !errors.As(err, &failure) || failure.Code != v1.Forbidden {
		t.Fatal("inventory obtained migration authority", err)
	}
	if _, err := f.client.Balance(ctx, "other-player", "coins"); !errors.As(err, &failure) || failure.Code != v1.Forbidden {
		t.Fatal("subject scope bypass", err)
	}
}

var injected = errors.New("injected Inventory outbox failure")

type failingStore struct{ inv.Store }

func (s failingStore) Transact(ctx context.Context, fn func(inv.Tx) error) error {
	return s.Store.Transact(ctx, func(tx inv.Tx) error { return fn(failingTx{tx}) })
}

type failingTx struct{ inv.Tx }

func (failingTx) Enqueue(idomain.SettlementCommand) error { return injected }
func TestInventoryCommitFailureRecoversWithoutSharedWalletRollback(t *testing.T) {
	f := stack(t)
	f.seed(t, 10)
	op := f.start(t, "repair", "item-a", idomain.Repair)
	broken, err := inv.New(failingStore{f.is}, pricing{8}, allowInventory{})
	if err != nil {
		t.Fatal(err)
	}
	worker := f.worker(f.client)
	worker.Service = broken
	if _, err := worker.RunOnce(ctx); !errors.Is(err, injected) {
		t.Fatal("missing injected failure", err)
	}
	// Wallet committed its reservation independently, while Inventory rolled back repair,
	// inbox and capture outbox together. The committed Wallet event resumes the saga.
	f.balance(t, 10, 8)
	if condition, status := f.item(t, "item-a"); condition != "heavy" || status != idomain.Locked {
		t.Fatal(condition, status)
	}
	if f.operation(t, op.ID).Stage != idomain.AwaitFunds {
		t.Fatal("partial Inventory commit")
	}
	if _, err := f.dispatch().RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(4 * time.Second)
	f.drain(t)
	f.balance(t, 2, 0)
	if f.operation(t, op.ID).Stage != idomain.Completed || f.playerJournalCount(t) != 2 {
		t.Fatal("recovery duplicated or lost effect")
	}
}

type losePublication struct {
	v1.EventSink
	lost bool
}

func (p *losePublication) Deliver(ctx context.Context, event v1.Event) error {
	if err := p.EventSink.Deliver(ctx, event); err != nil {
		return err
	}
	if !p.lost {
		p.lost = true
		return errors.New("acknowledgment lost after recipient commit")
	}
	return nil
}
func TestWalletOutboxRetryAfterRecipientCommit(t *testing.T) {
	f := stack(t)
	op := f.start(t, "sale", "item-a", idomain.Sell)
	f.drain(t)
	sink := &losePublication{EventSink: bridge.Receiver{Service: f.inventory, Principal: inv.Principal{Kind: "service", ID: "test-wallet-events"}, Producer: "inventory", Treasury: bridge.DefaultBuybackTreasury}}
	dispatcher := f.dispatch()
	dispatcher.Publisher = events.Publisher{Sink: sink}
	stats, err := dispatcher.RunOnce(ctx)
	if err == nil || stats.Retried != 1 {
		t.Fatal(stats, err)
	}
	completed := f.operation(t, op.ID)
	f.now = f.now.Add(4 * time.Second)
	stats, err = f.dispatch().RunOnce(ctx)
	if err != nil || stats.Published != 1 {
		t.Fatal(stats, err)
	}
	if f.operation(t, op.ID).Version != completed.Version || f.playerJournalCount(t) != 1 {
		t.Fatal("retry repeated the effect")
	}
	pending, err := f.ws.PendingEvents(ctx)
	if err != nil || len(pending) != 0 {
		t.Fatal(pending, err)
	}
}

type forbiddenClient struct{ v1.Client }

func (forbiddenClient) Execute(context.Context, v1.Command) (v1.Receipt, error) {
	return v1.Receipt{}, &v1.Error{Code: v1.Forbidden}
}
func TestPermanentIntegrationFailureIsVisibleAndDoesNotRestoreItem(t *testing.T) {
	f := stack(t)
	op := f.start(t, "sale", "item-a", idomain.Sell)
	stats, err := f.worker(forbiddenClient{f.client}).RunOnce(ctx)
	if err != nil || stats.Failed != 1 {
		t.Fatal(stats, err)
	}
	observed := f.operation(t, op.ID)
	if observed.Stage != idomain.Reconciliation || observed.Reason != v1.Forbidden {
		t.Fatal(observed)
	}
	if _, status := f.item(t, "item-a"); status != idomain.Consumed {
		t.Fatal("restored without Wallet closure")
	}
	f.balance(t, 0, 0)
}

func TestCancelRacesRepairCommitWithoutFreeRepairOrStrandedFunds(t *testing.T) {
	f := stack(t)
	f.seed(t, 200)
	var spent int64
	for n := range 10 {
		item := fmt.Sprint("racing-", n)
		if _, err := f.idb.Exec(`INSERT INTO inventory.items(id,owner,definition,condition,origin,status) VALUES($1,'player','compass','heavy','opening','available')`, item); err != nil {
			t.Fatal(err)
		}
		op := f.start(t, item, item, idomain.Repair)
		var cancelErr, workerErr error
		var wg sync.WaitGroup
		wg.Go(func() { _, cancelErr = f.inventory.Cancel(ctx, "player", op.ID) })
		wg.Go(func() { _, workerErr = f.worker(f.client).RunOnce(ctx) })
		wg.Wait()
		if workerErr != nil {
			t.Fatal(workerErr)
		}
		if cancelErr != nil && !errors.Is(cancelErr, idomain.ErrConflict) {
			t.Fatal(cancelErr)
		}
		f.drain(t)
		latest := f.operation(t, op.ID)
		condition, status := f.item(t, item)
		switch latest.Stage {
		case idomain.Completed:
			spent += 8
			if condition != "slight" {
				t.Fatal(condition)
			}
		case idomain.Canceled:
			if condition != "heavy" {
				t.Fatal("free repair after cancellation")
			}
		default:
			t.Fatal("nonterminal race", latest)
		}
		if status != idomain.Available {
			t.Fatal("item stranded", status)
		}
	}
	f.balance(t, 200-spent, 0)
	for range 4 {
		stats, err := f.dispatch().RunOnce(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if stats.Claimed == 0 {
			break
		}
	}
	f.balance(t, 200-spent, 0)
}

func TestGooseDeliveryUpgradePreservesLedgerAndExistingOutbox(t *testing.T) {
	db := database(t)
	provider, err := wmigrate.Provider(db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, 3); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	terms := wdomain.Terms{Subject: "player", Asset: "coins", Units: 4, Purpose: wdomain.Reward, Evidence: "legacy-quote"}
	intent := wdomain.Intent{Producer: "inventory", ID: "legacy-intent", Kind: wdomain.Award, State: wdomain.Credited, Terms: &terms, Version: 1}
	journal, err := wdomain.SettlementJournal(intent, wdomain.Credit, now)
	if err != nil {
		t.Fatal(err)
	}
	event := wallet.Event{ID: "legacy-event", Receipt: wallet.Receipt{Intent: intent, JournalID: journal.ID}, At: now}
	body, _ := json.Marshal(intent)
	payload, _ := json.Marshal(event)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO wallet.intents(producer,id,body) VALUES($1,$2,$3)`, intent.Producer, intent.ID, body); err != nil {
		t.Fatal(err)
	}
	for _, a := range []wdomain.Account{wdomain.PlayerAccount(terms), wdomain.CounterAccount(terms, wdomain.Credit)} {
		if _, err := tx.Exec(`INSERT INTO wallet.accounts(id,subject,asset,role) VALUES($1,$2,$3,$4)`, a.ID, a.Subject, a.Asset, a.Role); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Exec(`INSERT INTO wallet.journals(id,producer,intent_id,asset,occurred_at) VALUES($1,$2,$3,$4,$5)`, journal.ID, intent.Producer, intent.ID, journal.Asset, now); err != nil {
		t.Fatal(err)
	}
	for n, p := range journal.Postings {
		if _, err := tx.Exec(`INSERT INTO wallet.postings(journal_id,ordinal,account_id,asset,side,units) VALUES($1,$2,$3,$4,$5,$6)`, journal.ID, n, p.Account, p.Asset, p.Side, p.Units); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Exec(`INSERT INTO wallet.outbox(id,payload,created_at) VALUES($1,$2,$3)`, event.ID, payload, now); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := db.QueryRow(`SELECT payload::text FROM wallet.outbox WHERE id=$1`, event.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Up(ctx); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := db.QueryRow(`SELECT payload::text FROM ledger.outbox WHERE id=$1`, event.ID).Scan(&after); err != nil || before != after {
		t.Fatal("migration rewrote historical fact", err)
	}
	store := wpg.New(db)
	balance, err := store.Balance(ctx, "player", "coins")
	if err != nil || balance.Posted != 4 {
		t.Fatal(balance, err)
	}
	leased, err := store.ClaimEvents(ctx, "new-dispatcher", now.Add(time.Minute), time.Minute, 8)
	if err != nil || len(leased) != 1 || leased[0].Event.ID != event.ID {
		t.Fatal(leased, err)
	}
}

type malformedClient struct {
	v1.Client
	kind string
}

func (c malformedClient) Execute(_ context.Context, cmd v1.Command) (v1.Receipt, error) {
	r := v1.Receipt{IntentID: cmd.IntentID, State: "reserved", Version: 1, Terms: cmd.Terms}
	switch c.kind {
	case "missing_terms":
		r.Terms = nil
	case "terms_mismatch":
		copied := *cmd.Terms
		copied.Units = "99"
		r.Terms = &copied
	case "wrong_kind":
		r.State = "credited"
		r.JournalID = "journal"
	}
	return r, nil
}
func TestMalformedProviderReplyCannotCommitRepair(t *testing.T) {
	for _, kind := range []string{"missing_terms", "terms_mismatch", "wrong_kind"} {
		t.Run(kind, func(t *testing.T) {
			f := stack(t)
			op := f.start(t, "repair", "item-a", idomain.Repair)
			stats, err := f.worker(malformedClient{Client: f.client, kind: kind}).RunOnce(ctx)
			if err != nil || stats.Failed != 1 {
				t.Fatal(stats, err)
			}
			if f.operation(t, op.ID).Stage != idomain.Reconciliation {
				t.Fatal("invalid reply accepted")
			}
			if condition, status := f.item(t, "item-a"); condition != "heavy" || status != idomain.Locked {
				t.Fatal(condition, status)
			}
			f.balance(t, 0, 0)
		})
	}
}

func TestProducerScopedPublicationDoesNotConsumeOtherContextsEvents(t *testing.T) {
	f := stack(t)
	f.seed(t, 10)
	f.start(t, "sale", "item-a", idomain.Sell)
	f.drain(t)
	stats, err := f.dispatch().RunOnce(ctx)
	if err != nil || stats.Published != 1 {
		t.Fatal(stats, err)
	}
	pending, err := f.ws.PendingEvents(ctx)
	if err != nil || len(pending) != 1 || pending[0].Receipt.Intent.Producer != "treasury" {
		t.Fatal("another producer's event consumed", pending, err)
	}
}
