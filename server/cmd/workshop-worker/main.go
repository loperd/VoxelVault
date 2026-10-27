// workshop-worker runs the Inventory saga and its scoped Wallet reply dispatcher using
// independent database connections. It never applies migrations or imports legacy data.
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/voxel-vault/api/internal/economyruntime"
	bridge "github.com/voxel-vault/api/internal/integrations/inventoryledger"
	"github.com/voxel-vault/api/internal/rulebookjson"
	ipg "github.com/voxel-vault/api/inventory/adapters/postgres"
	pricing "github.com/voxel-vault/api/inventory/adapters/rulebook"
	inv "github.com/voxel-vault/api/inventory/application"
	rules "github.com/voxel-vault/api/inventory/domain/rulebook"
	"github.com/voxel-vault/api/ledger/adapters/authorization"
	"github.com/voxel-vault/api/ledger/adapters/inbound/local"
	"github.com/voxel-vault/api/ledger/adapters/outbound/events"
	wpg "github.com/voxel-vault/api/ledger/adapters/postgres"
	wallet "github.com/voxel-vault/api/ledger/application"
	wdomain "github.com/voxel-vault/api/ledger/domain"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func connect(ctx context.Context, env, versionTable string, minimum int64) (*sql.DB, error) {
	dsn := os.Getenv(env)
	if dsn == "" {
		return nil, fmt.Errorf("%s is required", env)
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("invalid %s configuration", env)
	}
	db.SetMaxOpenConns(12)
	db.SetMaxIdleConns(4)
	var version int64
	if err := db.QueryRowContext(ctx, `SELECT max(version_id) FROM `+versionTable).Scan(&version); err != nil {
		db.Close()
		return nil, fmt.Errorf("%s: schema version check failed; run the context migration command", env)
	}
	if version < minimum {
		db.Close()
		return nil, fmt.Errorf("%s: schema version %d is below required %d", env, version, minimum)
	}
	return db, nil
}
func run(once bool) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var assets []string
	for _, asset := range strings.Split(os.Getenv("WORKSHOP_WALLET_ASSETS"), ",") {
		if asset = strings.TrimSpace(asset); asset != "" {
			assets = append(assets, asset)
		}
	}
	var materials []string
	for _, asset := range assets {
		if asset != "currency" {
			materials = append(materials, asset)
		}
	}
	policy, err := economyruntime.WalletAuthorizer(nil, []authorization.Grant{{Producer: "inventory", Actions: []wdomain.Action{wdomain.Reserve, wdomain.Capture, wdomain.Cancel, wdomain.Credit, wdomain.Close, wdomain.Payout, wdomain.ClosePayout, wallet.ReadCapability}, Assets: assets, AllSubjects: true, Purposes: []wdomain.Purpose{wdomain.Spending, wdomain.Reward, wdomain.Buyback}, Treasuries: []string{bridge.DefaultBuybackTreasury}, Scopes: []authorization.ResourceScope{{Purpose: wdomain.Spending, Assets: materials}, {Purpose: wdomain.Reward, Assets: materials}, {Purpose: wdomain.Buyback, Assets: []string{"currency"}}}}})
	if err != nil {
		return fmt.Errorf("WORKSHOP_WALLET_ASSETS must explicitly allow the settlement assets")
	}
	idb, err := connect(startup, "INVENTORY_DATABASE_URL", "inventory_schema_version", 4)
	if err != nil {
		return err
	}
	defer idb.Close()
	wdb, err := connect(startup, "WALLET_DATABASE_URL", "wallet_schema_version", 7)
	if err != nil {
		return err
	}
	defer wdb.Close()
	config := os.Getenv("ECONOMY_CONFIG")
	if config == "" {
		config = "config/economy.json"
	}
	rb, err := rulebookjson.Load(config)
	if err != nil {
		return err
	}
	is, ws := ipg.New(idb), wpg.New(wdb)
	invAuth, err := economyruntime.InventoryAuthorizer(nil, nil)
	if err != nil {
		return err
	}
	service, err := inv.New(is, pricing.Pricing{Current: func() *rules.Rulebook { return rb }, Clock: time.Now}, invAuth)
	if err != nil {
		return err
	}
	account, err := wallet.New(ws, policy, time.Now)
	if err != nil {
		return err
	}
	client, err := local.New(account, "inventory")
	if err != nil {
		return err
	}
	scoped, err := ws.EventsFor("inventory")
	if err != nil {
		return err
	}
	owner := fmt.Sprintf("workshop-%d", os.Getpid())
	worker := inv.Worker{Store: is, Authorizer: invAuth, Settlement: bridge.Settlement{Client: client, Treasury: bridge.DefaultBuybackTreasury}, Service: service, Owner: owner, Clock: time.Now, Lease: 30 * time.Second, Limit: 64}
	dispatcher := wallet.Dispatcher{Store: scoped, Publisher: events.Publisher{Sink: bridge.Receiver{Service: service, Producer: "inventory", Treasury: bridge.DefaultBuybackTreasury, Principal: inv.Principal{Kind: "service", ID: economyruntime.WalletEventsPrincipal}}}, Owner: owner, Clock: time.Now, Lease: 30 * time.Second, Limit: 64}
	tick := func() error {
		pass, done := context.WithTimeout(ctx, 10*time.Second)
		defer done()
		work, workErr := worker.RunOnce(economyruntime.ServiceContext(pass, economyruntime.WorkerPrincipal))
		delivery, deliveryErr := dispatcher.RunOnce(pass)
		if work.Claimed > 0 || delivery.Claimed > 0 {
			fmt.Printf("Inventory completed=%d retried=%d reconciliation=%d; Wallet published=%d retried=%d\n", work.Completed, work.Retried, work.Failed, delivery.Published, delivery.Retried)
		}
		if workErr != nil {
			return workErr
		}
		return deliveryErr
	}
	if once {
		return tick()
	}
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := tick(); err != nil && ctx.Err() == nil {
			fmt.Fprintln(os.Stderr, "Workshop delivery will retry:", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
func main() {
	once := flag.Bool("once", false, "process one delivery pass and exit")
	flag.Parse()
	if err := run(*once); err != nil {
		fmt.Fprintln(os.Stderr, "Workshop worker failed:", err)
		os.Exit(1)
	}
}
