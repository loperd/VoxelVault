package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	identityv1 "github.com/voxel-vault/api/identity/contracts/v1"
	"github.com/voxel-vault/api/internal/config"
	"github.com/voxel-vault/api/internal/economyruntime"
	bridge "github.com/voxel-vault/api/internal/integrations/inventoryledger"
	ilocal "github.com/voxel-vault/api/inventory/adapters/inbound/local"
	ipg "github.com/voxel-vault/api/inventory/adapters/postgres"
	imigrate "github.com/voxel-vault/api/inventory/adapters/postgres/migrations"
	inv "github.com/voxel-vault/api/inventory/application"
	iv1 "github.com/voxel-vault/api/inventory/contracts/v1"
	"github.com/voxel-vault/api/inventory/domain/rulebook"
	"github.com/voxel-vault/api/inventory/domain/rulebook/rulebooktest"
	"github.com/voxel-vault/api/ledger/adapters/authorization"
	wlocal "github.com/voxel-vault/api/ledger/adapters/inbound/local"
	wpg "github.com/voxel-vault/api/ledger/adapters/postgres"
	wmigrate "github.com/voxel-vault/api/ledger/adapters/postgres/migrations"
	wallet "github.com/voxel-vault/api/ledger/application"
	wv1 "github.com/voxel-vault/api/ledger/contracts/v1"
	wdomain "github.com/voxel-vault/api/ledger/domain"
)

var httpDBSeq atomic.Uint64

func httpDatabase(t *testing.T) (*sql.DB, string) {
	t.Helper()
	dsn := os.Getenv("TEST_WALLET_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_WALLET_DATABASE_URL must permit disposable test databases")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("http_context_test_%d_%d", os.Getpid(), httpDBSeq.Add(1))
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
	t.Cleanup(func() {
		db.Close()
		if _, err := admin.Exec(`DROP DATABASE ` + name + ` WITH(FORCE)`); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	return db, u.String()
}

type httpContexts struct {
	source, idb, wdb *sql.DB
	idsn, wdsn       string
	identity         *IdentityPorts
	acl              *fixtureACL
	securityDB       *sql.DB
	sessions         map[string]string
	rb               *rulebook.Rulebook
	runtime          *economyruntime.Runtime
	server           *Server
}

func (f *httpContexts) fundBuyback(t *testing.T, units int64) {
	t.Helper()
	policy, err := authorization.New([]authorization.Grant{{Producer: "funding-test", Actions: []wdomain.Action{wdomain.FundTreasury}, MaxUnits: units, Assets: []string{"currency"}, Subjects: []string{"system"}, Purposes: []wdomain.Purpose{wdomain.TreasuryOpening}, Treasuries: []string{bridge.DefaultBuybackTreasury}}})
	if err != nil {
		t.Fatal(err)
	}
	if err = wpg.New(f.wdb).OpenAccount(context.Background(), wdomain.TreasuryAccount(bridge.DefaultBuybackTreasury, "currency")); err != nil {
		t.Fatal(err)
	}
	_, err = (wallet.TreasuryOpeningService{Store: wpg.New(f.wdb), Authorizer: allowIssuance{policy}, Producer: "funding-test", Clock: time.Now}).Open(context.Background(), wallet.TreasuryOpening{Treasury: bridge.DefaultBuybackTreasury, Asset: "currency", Units: units, Source: "test-allocation", Reference: "buyback-budget"})
	if err != nil {
		t.Fatal(err)
	}
}

func httpExec(t *testing.T, db *sql.DB, q string, args ...any) {
	t.Helper()
	if _, err := db.Exec(q, args...); err != nil {
		t.Fatal(err)
	}
}

func httpStack(t *testing.T, activate bool) *httpContexts {
	t.Helper()
	f := &httpContexts{}
	var sourceDSN string
	f.source, sourceDSN = httpDatabase(t)
	f.idb, f.idsn = httpDatabase(t)
	f.wdb, f.wdsn = httpDatabase(t)
	var err error
	f.securityDB = f.source
	f.setupIdentity(t, sourceDSN)
	f.rb = rulebooktest.Build(t, rulebooktest.Set(map[string]float64{"chest.destroy.impact.perWear": 0, "chest.destroy.opening.perWear": 0}))
	for _, m := range []struct {
		db *sql.DB
		up func(context.Context, *sql.DB) error
	}{{f.idb, imigrate.Up}, {f.wdb, wmigrate.Up}} {
		if err = m.up(context.Background(), m.db); err != nil {
			t.Fatal(err)
		}
	}
	if activate {
		f.importItems(t)
		f.importChests(t)
		f.activate(t)
	}
	return f
}

// The baseline the contexts start from: alice and bob own one item each, two currencies and
// alice's chest. Both contexts are stamped with the same source and digest.
const (
	httpSource = "http-source"
	httpDigest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

func (f *httpContexts) importItems(t *testing.T) {
	t.Helper()
	p, err := authorization.New([]authorization.Grant{{Producer: "baseline-opening", Actions: []wdomain.Action{wdomain.Credit}, Assets: []string{"currency", "end-shards"}, AllSubjects: true, Purposes: []wdomain.Purpose{wdomain.OpeningBalance}}})
	if err != nil {
		t.Fatal(err)
	}
	ctx := inv.WithAuthenticatedPrincipal(context.Background(), inv.Principal{Kind: "operator", ID: "test-fixture"})
	w := wlocal.OpeningClient{Service: wallet.OpeningService{Store: wpg.New(f.wdb), Authorizer: allowIssuance{p}, Producer: "baseline-opening"}}
	balances := []wv1.OpeningBalance{{Subject: "alice", Asset: "currency", Units: "9007199254740993"}, {Subject: "alice", Asset: "end-shards", Units: "20"}, {Subject: "bob", Asset: "currency", Units: "3"}, {Subject: "bob", Asset: "end-shards", Units: "0"}}
	if err = w.ImportOpening(ctx, wv1.Opening{Source: httpSource, Digest: httpDigest, At: time.Now().UTC().Format(time.RFC3339Nano), Balances: balances}); err != nil {
		t.Fatal(err)
	}
	i := ilocal.OpeningClient{Service: inv.OpeningService{Authorizer: allowInventory{}, Store: ipg.New(f.idb)}}
	items := []iv1.OpeningItem{{ID: "alice-item", Owner: "alice", Definition: "item-a", Condition: "heavy"}, {ID: "bob-item", Owner: "bob", Definition: "item-b", Condition: "heavy"}}
	if err = i.ImportItems(ctx, iv1.Opening{Source: httpSource, Digest: httpDigest, Items: items}); err != nil {
		t.Fatal(err)
	}
}

func (f *httpContexts) importChests(t *testing.T) {
	t.Helper()
	at := time.Now().UTC().Format(time.RFC3339Nano)
	r := iv1.ChestsOpening{Source: httpSource, Digest: httpDigest,
		Owners: []iv1.OpeningOwner{{ID: "alice", StarterGrantedAt: &at}, {ID: "bob", StarterGrantedAt: &at}},
		Chests: []iv1.OpeningChest{{ID: "existing-chest", Owner: "alice", Type: "ender", Seed: "9007199254740993", Revision: "test.1", Contents: []iv1.ChestSlot{{Item: "item-a", Weight: 1}}, Traits: []iv1.ChestTrait{}, Rarity: "common", Condition: 1, Source: "admin", Parents: []string{}, Status: "available", CreatedAt: at}},
	}
	c := ilocal.ChestsOpeningClient{Service: inv.ChestsOpeningService{Authorizer: allowInventory{}, Store: ipg.New(f.idb)}}
	if err := c.ImportChests(inv.WithAuthenticatedPrincipal(context.Background(), inv.Principal{Kind: "operator", ID: "test-fixture"}), r); err != nil {
		t.Fatal(err)
	}
}

func (f *httpContexts) activate(t *testing.T) {
	t.Helper()
	r, err := economyruntime.New(context.Background(), f.idsn, f.wdsn, []string{"currency", "end-shards"}, f.rb, economyruntime.Options{StarterChests: "ender:1", SecurityDB: f.securityDB})
	if err != nil {
		t.Fatal(err)
	}
	f.runtime = r
	t.Cleanup(r.Close)
	doc, err := os.ReadFile("../../config/transfers.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = economyruntime.SeedLedger(context.Background(), f.wdb, doc); err != nil {
		t.Fatal(err)
	}
	if err = r.EnableTransfer(context.Background(), f.identity.Profiles.(identityv1.RecipientResolver)); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{AllowedOrigins: []string{"http://localhost"}, StarterChests: "ender:1"}
	f.server, err = New(cfg, f.identity, f.rb, &ContextPorts{Collection: r.Collection, Workshop: r.Workshop, Wallet: r.Wallet, Transfer: r.Transfer, Currency: r.Currency, Subjects: f.identity.Profiles, UserContext: r.UserContext, RecipientPerMinute: 10, QuotePerMinute: 30, TransferPerMinute: 30}, r.Guard.Check)
	if err != nil {
		t.Fatal(err)
	}
}

func (f *httpContexts) startWorker(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); f.runtime.Run(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
}

func (f *httpContexts) request(method, path, player, key, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://localhost"+path, strings.NewReader(body))
	if player != "" {
		r.Header.Set("X-Internal-Token", fixtureToken)
		r.Header.Set("X-User-Id", player)
		r.Header.Set("X-Session-Id", f.sessions[player])
		r.Header.Set("X-Scopes", fixtureScopes(f, player))
	}
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	if method != "GET" {
		r.Header.Set("Origin", "http://localhost")
	}
	w := httptest.NewRecorder()
	f.server.Handler().ServeHTTP(w, r)
	return w
}

func decodeResponse(t *testing.T, w *httptest.ResponseRecorder, status int, v any) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("HTTP %d: %s", w.Code, w.Body.String())
	}
	if v != nil {
		if err := json.Unmarshal(w.Body.Bytes(), v); err != nil {
			t.Fatal(err)
		}
	}
}

func (f *httpContexts) wait(t *testing.T, player, id, stage string) iv1.Operation {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var o iv1.Operation
		decodeResponse(t, f.request("GET", "/api/v1/inventory/operations/"+id, player, "", ""), 200, &o)
		if o.Stage == stage {
			return o
		}
		if time.Now().After(deadline) {
			t.Fatalf("operation stayed in %s instead of %s", o.Stage, stage)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestContextAPIRepairsThroughSagaAndReadsSeparateWallet(t *testing.T) {
	f := httpStack(t, true)
	f.startWorker(t)
	w := f.request("GET", "/api/v1/inventory/items?owner=bob", "alice", "", "")
	var items map[string]json.RawMessage
	decodeResponse(t, w, 200, &items)
	if _, exists := items["balances"]; exists {
		t.Fatal("Wallet balances are still exposed in Inventory")
	}
	if strings.Contains(string(items["items"]), "bob-item") || !strings.Contains(string(items["items"]), "alice-item") {
		t.Fatal("subject override", string(items["items"]))
	}
	decodeResponse(t, f.request("POST", "/api/v1/inventory/items/alice-item/repair", "alice", "", "{}"), 400, nil)
	var o iv1.Operation
	w = f.request("POST", "/api/v1/inventory/items/alice-item/repair", "alice", "repair-request", `{"owner":"bob","units":"1"}`)
	decodeResponse(t, w, 202, &o)
	if w.Header().Get("Location") != "/api/v1/inventory/operations/"+o.ID {
		t.Fatal("missing operation location")
	}
	f.wait(t, "alice", o.ID, "completed")
	decodeResponse(t, f.request("GET", "/api/v1/inventory/operations/"+o.ID, "bob", "", ""), 404, nil)
	var again iv1.Operation
	decodeResponse(t, f.request("POST", "/api/v1/inventory/items/alice-item/repair", "alice", "repair-request", "{}"), 202, &again)
	if again.ID != o.ID {
		t.Fatal("retry created a second repair")
	}
	decodeResponse(t, f.request("POST", "/api/v1/inventory/items/alice-item/sell", "alice", "repair-request", "{}"), 409, nil)
	var b struct {
		Balances []wv1.AssetBalance `json:"balances"`
	}
	decodeResponse(t, f.request("GET", "/api/v1/wallet?owner=bob", "alice", "", ""), 200, &b)
	if len(b.Balances) != 1 || b.Balances[0].Available != "9007199254740993" {
		t.Fatal(b)
	}
	h, err := f.runtime.Ledger.History(f.runtime.UserContext(context.Background(), "alice"), "alice", "end-shards", "", 25)
	if err != nil {
		t.Fatal(err)
	}
	if len(h.Entries) != 2 || h.Entries[0].Purpose != "spending" || h.Entries[0].Units != "4" || h.Entries[0].Direction != "debit" {
		t.Fatal(h)
	}
}

func TestContextAPIBuybackWithoutBudgetRestoresItemWithoutCredit(t *testing.T) {
	f := httpStack(t, true)
	f.startWorker(t)
	var operation iv1.Operation
	decodeResponse(t, f.request("POST", "/api/v1/inventory/items/alice-item/sell", "alice", "unfunded-sale", "{}"), 202, &operation)
	f.wait(t, "alice", operation.ID, "restored")
	var response struct {
		Balances []wv1.AssetBalance `json:"balances"`
	}
	decodeResponse(t, f.request("GET", "/api/v1/wallet", "alice", "", ""), 200, &response)
	if response.Balances[0].Available != "9007199254740993" {
		t.Fatal("unfunded buyback minted money", response)
	}
	var location string
	if err := f.idb.QueryRow(`SELECT custody->>'location' FROM inventory.instance_registry WHERE kind='item' AND id='alice-item'`).Scan(&location); err != nil || location != "player" {
		t.Fatal("unfunded item entered stock", location, err)
	}
	var journals int
	if err := f.wdb.QueryRow(`SELECT count(*) FROM ledger.journals WHERE producer='inventory'`).Scan(&journals); err != nil || journals != 0 {
		t.Fatal("unfunded sale posted money", journals, err)
	}
}

func TestReadinessRequiresAllBaselines(t *testing.T) {
	f := httpStack(t, false)
	try := func() {
		t.Helper()
		if r, err := economyruntime.New(context.Background(), f.idsn, f.wdsn, []string{"currency", "end-shards"}, f.rb, economyruntime.Options{StarterChests: "ender:1", SecurityDB: f.securityDB}); err == nil {
			r.Close()
			t.Fatal("premature context activation")
		}
	}
	try()
	f.importItems(t)
	try()
	f.importChests(t)
	f.activate(t)
	decodeResponse(t, f.request("GET", "/readyz", "", "", ""), 200, nil)
	httpExec(t, f.wdb, `UPDATE ledger.opening_baseline SET digest='different'`)
	decodeResponse(t, f.request("GET", "/readyz", "", "", ""), 503, nil)
	decodeResponse(t, f.request("POST", "/api/v1/inventory/items/alice-item/repair", "alice", "repair", "{}"), 503, nil)
	decodeResponse(t, f.request("GET", "/api/v1/wallet", "", "", ""), 401, nil)
	httpExec(t, f.wdb, `UPDATE ledger.opening_baseline SET digest=$1`, httpDigest)
	decodeResponse(t, f.request("GET", "/api/v1/wallet", "alice", "", ""), 200, nil)
}

func TestContextAPICancellationAndInsufficientFundsDoNotChangeItems(t *testing.T) {
	f := httpStack(t, true)
	var a, b iv1.Operation
	decodeResponse(t, f.request("POST", "/api/v1/inventory/items/alice-item/repair", "alice", "cancel-repair", "{}"), 202, &a)
	decodeResponse(t, f.request("POST", "/api/v1/inventory/operations/"+a.ID+"/cancel", "bob", "", "{}"), 404, nil)
	decodeResponse(t, f.request("POST", "/api/v1/inventory/operations/"+a.ID+"/cancel", "alice", "", "{}"), 202, nil)
	decodeResponse(t, f.request("POST", "/api/v1/inventory/items/bob-item/repair", "bob", "poor-repair", "{}"), 202, &b)
	f.startWorker(t)
	f.wait(t, "alice", a.ID, "canceled")
	f.wait(t, "bob", b.ID, "canceled")
	for _, id := range []string{"alice-item", "bob-item"} {
		var condition, status string
		if err := f.idb.QueryRow(`SELECT condition,status FROM inventory.items WHERE id=$1`, id).Scan(&condition, &status); err != nil || condition != "heavy" || status != "available" {
			t.Fatal(condition, status, err)
		}
	}
}

func TestContextAPIConcurrentRequestsShareOneOperation(t *testing.T) {
	f := httpStack(t, true)
	f.startWorker(t)
	results := make(chan *httptest.ResponseRecorder, 10)
	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- f.request("POST", "/api/v1/inventory/items/alice-item/repair", "alice", "concurrent-repair", "{}")
		}()
	}
	wg.Wait()
	close(results)
	id := ""
	for w := range results {
		var o iv1.Operation
		decodeResponse(t, w, 202, &o)
		if id != "" && o.ID != id {
			t.Fatal("multiple intents")
		}
		id = o.ID
	}
	f.wait(t, "alice", id, "completed")
	var n int
	if err := f.wdb.QueryRow(`SELECT count(*) FROM ledger.journals WHERE producer='inventory'`).Scan(&n); err != nil || n != 1 {
		t.Fatal("duplicate capture", n, err)
	}
}

func TestContextAPIChestsAndMergesUsePublishedCollectionPorts(t *testing.T) {
	f := httpStack(t, true)
	var cs []map[string]any
	decodeResponse(t, f.request("GET", "/api/v1/inventory", "alice", "", ""), 200, &cs)
	if len(cs) != 1 || cs[0]["seed"] != "9007199254740993" {
		t.Fatal("exact seed lost", cs)
	}
	decodeResponse(t, f.request("POST", "/api/v1/inventory/existing-chest/claim", "bob", "", `{"sessionId":"s"}`), 404, nil)
	decodeResponse(t, f.request("POST", "/api/v1/inventory/existing-chest/claim", "alice", "", `{"sessionId":"s"}`), 200, nil)
	w := f.request("POST", "/api/v1/inventory/existing-chest/open", "alice", "", `{"sessionId":"s"}`)
	decodeResponse(t, w, 200, nil)
	if _, err := f.acl.AddGroupingPolicy("alice", "admin"); err != nil {
		t.Fatal(err)
	}
	decodeResponse(t, f.request("POST", "/api/v1/admin/users/alice/chests", "alice", "grant-chests", `{"caseId":"ender","count":2}`), 201, nil)
	decodeResponse(t, f.request("POST", "/api/v1/admin/users/alice/chests", "alice", "grant-chests", `{"caseId":"ender","count":2}`), 201, nil)
	decodeResponse(t, f.request("GET", "/api/v1/inventory", "alice", "", ""), 200, &cs)
	ids := []string{}
	for _, c := range cs {
		if c["status"] == "available" {
			ids = append(ids, c["id"].(string))
		}
	}
	if len(ids) != 2 {
		t.Fatal(cs)
	}
	body := fmt.Sprintf(`{"a":%q,"b":%q}`, ids[0], ids[1])
	decodeResponse(t, f.request("GET", "/api/v1/inventory/merge?a="+ids[0]+"&b="+ids[1], "alice", "", ""), 200, nil)
	decodeResponse(t, f.request("POST", "/api/v1/inventory/merge", "alice", "merge-chests", body), 201, nil)
	decodeResponse(t, f.request("POST", "/api/v1/inventory/merge", "alice", "merge-chests", body), 201, nil)
	decodeResponse(t, f.request("POST", "/api/v1/admin/users/alice/chests", "bob", "forged", `{"caseId":"ender","count":1}`), 403, nil)
	decodeResponse(t, f.request("POST", "/api/v1/admin/users/alice/chests", "alice", "bad-grant", `{`), 400, nil)
}

func TestContextMergeOddsAnswerPercentsOnlyForOwnAvailablePair(t *testing.T) {
	f := httpStack(t, true)
	if _, err := f.acl.AddGroupingPolicy("alice", "admin"); err != nil {
		t.Fatal(err)
	}
	decodeResponse(t, f.request("POST", "/api/v1/admin/users/alice/chests", "alice", "odds-grant", `{"caseId":"ender","count":2}`), 201, nil)
	var cs []map[string]any
	decodeResponse(t, f.request("GET", "/api/v1/inventory", "alice", "", ""), 200, &cs)
	ids := []string{}
	for _, c := range cs {
		if c["status"] == "available" && c["id"] != "existing-chest" {
			ids = append(ids, c["id"].(string))
		}
	}
	if len(ids) != 2 {
		t.Fatal(cs)
	}
	odds := "/api/v1/inventory/merge?a=" + ids[0] + "&b=" + ids[1]
	var o mergeOddsDTO
	decodeResponse(t, f.request("GET", odds, "alice", "", ""), 200, &o)
	if o.Contents.Total < 1 || o.Contents.Kept < 1 || o.Contents.Keep != percent(float64(o.Contents.Kept), float64(o.Contents.Total)) || o.Traits == nil {
		t.Fatal("odds shape", o)
	}
	decodeResponse(t, f.request("GET", odds, "bob", "", ""), 404, nil)
	decodeResponse(t, f.request("POST", "/api/v1/inventory/merge", "alice", "odds-merge", fmt.Sprintf(`{"a":%q,"b":%q}`, ids[0], ids[1])), 201, nil)
	decodeResponse(t, f.request("GET", odds, "alice", "", ""), 409, nil)
}

func TestWalletHistoryPaginationIsScopedAndKeepsExactIntegers(t *testing.T) {
	f := httpStack(t, true)
	policy, err := authorization.New([]authorization.Grant{{Producer: "treasury-test", Actions: []wdomain.Action{wdomain.Credit}, Assets: []string{"currency"}, AllSubjects: true, Purposes: []wdomain.Purpose{wdomain.Reward}}})
	if err != nil {
		t.Fatal(err)
	}
	// Identical timestamps exercise the journal-ID tie breaker between pages.
	at := time.Now().UTC().Truncate(time.Microsecond)
	service, err := wallet.New(wpg.New(f.wdb), policy, func() time.Time { return at })
	if err != nil {
		t.Fatal(err)
	}
	for i := range 9 {
		id := fmt.Sprintf("history-%d", i)
		for _, subject := range []string{"alice", "bob"} {
			if _, err = service.Execute(context.Background(), wallet.Command{Producer: "treasury-test", ID: subject + id, IntentID: subject + id, Action: wdomain.Credit, Terms: &wdomain.Terms{Subject: subject, Asset: "currency", Units: 1, Purpose: wdomain.Reward, Evidence: id}}); err != nil {
				t.Fatal(err)
			}
		}
	}
	cursor := ""
	seen := map[string]bool{}
	original := ""
	for {
		var h wv1.History
		path := "/api/v1/wallet/transactions?limit=2&asset=currency&cursor=" + url.QueryEscape(cursor)
		decodeResponse(t, f.request("GET", path, "alice", "", ""), 200, &h)
		for _, e := range h.Entries {
			if seen[e.ID] {
				t.Fatal("duplicate page entry")
			}
			seen[e.ID] = true
			if strings.HasPrefix(e.Reference, "bob") {
				t.Fatal("foreign transaction leaked", e)
			}
			if e.Purpose == "opening_balance" {
				original = e.Units
			}
		}
		if h.Next == "" {
			break
		}
		if cursor == "" {
			decodeResponse(t, f.request("GET", "/api/v1/wallet/transactions?asset=currency&cursor="+url.QueryEscape(h.Next), "bob", "", ""), 400, nil)
			decodeResponse(t, f.request("GET", "/api/v1/wallet/transactions?asset=end-shards&cursor="+url.QueryEscape(h.Next), "alice", "", ""), 400, nil)
		}
		cursor = h.Next
	}
	if len(seen) != 10 || original != "9007199254740993" {
		t.Fatal("missing/exact history entries", len(seen), original)
	}
	for _, query := range []string{"limit=0", "limit=101", "cursor=!!!"} {
		decodeResponse(t, f.request("GET", "/api/v1/wallet/transactions?"+query, "alice", "", ""), 400, nil)
	}
	decodeResponse(t, f.request("GET", "/api/v1/wallet/transactions?asset=foreign-asset", "alice", "", ""), 403, nil)
	decodeResponse(t, f.request("GET", "/api/v1/wallet/transactions", "", "", ""), 401, nil)
}

func TestContextAPIItemMergeCannotConsumeWorkshopLockedTwin(t *testing.T) {
	f := httpStack(t, true)
	httpExec(t, f.idb, `INSERT INTO inventory.items(id,owner,definition,condition,origin,status) VALUES('twin','alice','item-a','broken','','available')`)
	tx, err := f.idb.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err = ipg.BootstrapLifecycle(context.Background(), tx); err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var op iv1.Operation
	decodeResponse(t, f.request("POST", "/api/v1/inventory/items/twin/repair", "alice", "lock-twin", "{}"), 202, &op)
	body := `{"a":"alice-item","b":"twin"}`
	decodeResponse(t, f.request("POST", "/api/v1/inventory/items/merge", "alice", "merge-busy", body), 409, nil)
	decodeResponse(t, f.request("POST", "/api/v1/inventory/operations/"+op.ID+"/cancel", "alice", "", "{}"), 202, nil)
	f.startWorker(t)
	f.wait(t, "alice", op.ID, "canceled")
	decodeResponse(t, f.request("POST", "/api/v1/inventory/items/merge", "alice", "merge-busy", body), 200, nil)
	decodeResponse(t, f.request("POST", "/api/v1/inventory/items/merge", "alice", "merge-busy", body), 200, nil)
}

func TestContextActivationRejectsIncompleteAssetConfiguration(t *testing.T) {
	f := httpStack(t, false)
	if r, err := economyruntime.New(context.Background(), f.idsn, f.wdsn, []string{"currency"}, f.rb); err == nil {
		r.Close()
		t.Fatal("missing repair material accepted")
	}
	if _, err := New(config.Config{}, nil, f.rb, &ContextPorts{}, nil); err == nil {
		t.Fatal("partial dependency injection accepted")
	}
}

func TestWalletHistoryAggregatesSplitPostingsIntoOneTransaction(t *testing.T) {
	f := httpStack(t, true)
	terms := wdomain.Terms{Subject: "alice", Asset: "currency", Units: 3, Purpose: wdomain.Reward, Evidence: "split"}
	player, counter := wdomain.PlayerAccount(terms), wdomain.CounterAccount(terms, wdomain.Credit)
	err := wpg.New(f.wdb).Transact(context.Background(), func(tx wallet.Tx) error {
		if _, err := tx.LockIntent("split-test", "split"); err != nil {
			return err
		}
		if err := tx.LockAccounts([]wdomain.Account{player, counter}); err != nil {
			return err
		}
		if err := tx.SaveIntent(wdomain.Intent{Producer: "split-test", ID: "split", State: wdomain.Credited, Kind: wdomain.Award, Terms: &terms, Version: 1}); err != nil {
			return err
		}
		return tx.AppendJournal(wdomain.Journal{ID: "split-journal", Producer: "split-test", IntentID: "split", Asset: "currency", At: time.Now().UTC(), Postings: []wdomain.Posting{{Account: counter.ID, Asset: "currency", Side: wdomain.Dr, Units: 3}, {Account: player.ID, Asset: "currency", Side: wdomain.Cr, Units: 1}, {Account: player.ID, Asset: "currency", Side: wdomain.Cr, Units: 2}}})
	})
	if err != nil {
		t.Fatal(err)
	}
	var h wv1.History
	decodeResponse(t, f.request("GET", "/api/v1/wallet/transactions", "alice", "", ""), 200, &h)
	if len(h.Entries) != 2 || h.Entries[0].ID != "split-journal" || h.Entries[0].Units != "3" {
		t.Fatal("posting lines leaked as separate transactions", h)
	}
}
