// Package economyruntime is the composition root. Contexts exchange only published DTOs
// through adapters; each repository keeps its database and transaction private.
package economyruntime

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	cv1 "github.com/voxel-vault/api/currency/contracts/v1"
	bridge "github.com/voxel-vault/api/internal/integrations/inventoryledger"
	ilocal "github.com/voxel-vault/api/inventory/adapters/inbound/local"
	ipg "github.com/voxel-vault/api/inventory/adapters/postgres"
	ipricing "github.com/voxel-vault/api/inventory/adapters/rulebook"
	inv "github.com/voxel-vault/api/inventory/application"
	iv1 "github.com/voxel-vault/api/inventory/contracts/v1"
	"github.com/voxel-vault/api/inventory/domain/rulebook"
	"github.com/voxel-vault/api/ledger/adapters/authorization"
	wlocal "github.com/voxel-vault/api/ledger/adapters/inbound/local"
	"github.com/voxel-vault/api/ledger/adapters/outbound/events"
	wpg "github.com/voxel-vault/api/ledger/adapters/postgres"
	wallet "github.com/voxel-vault/api/ledger/application"
	wv1 "github.com/voxel-vault/api/ledger/contracts/v1"
	wdomain "github.com/voxel-vault/api/ledger/domain"
)

// Guard holds the economy back until both contexts carry the same complete baseline.
type Guard struct {
	Inventory iv1.BaselineReader
	Wallet    wv1.BaselineReader
}

func (g Guard) Check(ctx context.Context) error {
	if g.Inventory == nil || g.Wallet == nil {
		return fmt.Errorf("incomplete economy readiness configuration")
	}
	i, err := g.Inventory.Baseline(ctx)
	if err != nil {
		return err
	}
	w, err := g.Wallet.Baseline(ctx)
	if err != nil {
		return err
	}
	if !i.Complete || !w.Complete || i.Source == "" || i.Source != w.Source || i.Digest == "" || i.Digest != w.Digest {
		return fmt.Errorf("economy context baselines are incomplete or do not match")
	}
	return nil
}

type Runtime struct {
	Collection iv1.CollectionClient
	Workshop   iv1.WorkshopClient
	Wallet     wv1.ReadClient
	Ledger     wv1.ReadClient
	Transfer   wv1.TransferClient
	Currency   cv1.Provider
	Limits     TransferLimits
	ledgerDB   *sql.DB
	securityDB *sql.DB
	assets     []string
	Guard      Guard
	dbs        []*sql.DB
	worker     inv.Worker
	dispatcher wallet.Dispatcher
}

func (r *Runtime) UserContext(ctx context.Context, id string) context.Context {
	ctx = wallet.WithAuthenticatedPrincipal(ctx, wallet.Principal{Kind: "user", ID: id})
	return inv.WithAuthenticatedPrincipal(ctx, inv.Principal{Kind: "user", ID: id})
}

func (r *Runtime) Close() {
	for _, db := range r.dbs {
		db.Close()
	}
}
func connect(ctx context.Context, dsn, table string, minimum int64) (*sql.DB, error) {
	if dsn == "" {
		return nil, fmt.Errorf("%s connection is required", table)
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("invalid %s connection", table)
	}
	db.SetMaxOpenConns(16)
	db.SetMaxIdleConns(4)
	var version int64
	if err = db.QueryRowContext(ctx, `SELECT max(version_id) FROM `+table).Scan(&version); err != nil {
		db.Close()
		return nil, fmt.Errorf("%s version check failed; run context migrations", table)
	}
	if version < minimum {
		db.Close()
		return nil, fmt.Errorf("%s requires version %d", table, minimum)
	}
	return db, nil
}

type Options struct {
	StarterChests string
	SecurityDB    *sql.DB
}

func New(ctx context.Context, inventoryDSN, walletDSN string, assets []string, rb *rulebook.Rulebook, options ...Options) (*Runtime, error) {
	r := &Runtime{}
	if rb == nil {
		return nil, fmt.Errorf("rulebook is required")
	}
	allowed := map[string]bool{}
	unique := []string{}
	for _, asset := range assets {
		if !allowed[asset] {
			unique = append(unique, asset)
			allowed[asset] = true
		}
	}
	assets = unique
	if !allowed["currency"] {
		return nil, fmt.Errorf("WALLET_ASSETS must include currency")
	}
	for _, kind := range rb.Types() {
		if !allowed[rb.Material(kind)] {
			return nil, fmt.Errorf("WALLET_ASSETS must include rulebook material %s", rb.Material(kind))
		}
	}
	idb, err := connect(ctx, inventoryDSN, "inventory_schema_version", 5)
	if err != nil {
		return nil, err
	}
	r.dbs = append(r.dbs, idb)
	wdb, err := connect(ctx, walletDSN, "wallet_schema_version", 10)
	if err != nil {
		r.Close()
		return nil, err
	}
	r.dbs = append(r.dbs, wdb)
	var materials []string
	seenMaterials := map[string]bool{}
	for _, kind := range rb.Types() {
		material := rb.Material(kind)
		if material == "currency" {
			r.Close()
			return nil, fmt.Errorf("workshop material cannot be currency")
		}
		if !seenMaterials[material] {
			materials = append(materials, material)
			seenMaterials[material] = true
		}
	}
	if len(options) != 1 || options[0].SecurityDB == nil {
		r.Close()
		return nil, fmt.Errorf("Security role storage is required")
	}
	policy, err := WalletAuthorizer(options[0].SecurityDB, []authorization.Grant{
		{Producer: "player-api", Actions: []wdomain.Action{wallet.ReadCapability}, Assets: assets, AllSubjects: true},
		{Producer: "inventory", Actions: []wdomain.Action{wdomain.Reserve, wdomain.Capture, wdomain.Cancel, wdomain.Credit, wdomain.Close, wdomain.Payout, wdomain.ClosePayout}, Assets: assets, AllSubjects: true, Purposes: []wdomain.Purpose{wdomain.Spending, wdomain.Reward, wdomain.Buyback}, Treasuries: []string{bridge.DefaultBuybackTreasury}, Scopes: []authorization.ResourceScope{{Purpose: wdomain.Spending, Assets: materials}, {Purpose: wdomain.Reward, Assets: materials}, {Purpose: wdomain.Buyback, Assets: []string{"currency"}}}},
	})
	if err != nil {
		r.Close()
		return nil, fmt.Errorf("WALLET_ASSETS must explicitly allow player wallet reads and workshop settlement")
	}
	is, ws := ipg.New(idb), wpg.New(wdb)
	r.ledgerDB, r.securityDB = wdb, options[0].SecurityDB
	r.assets = append([]string(nil), assets...)
	invAuth, err := InventoryAuthorizer(options[0].SecurityDB)
	if err != nil {
		r.Close()
		return nil, err
	}
	starterConfig := ""
	if len(options) > 0 {
		starterConfig = options[0].StarterChests
	}
	starterPolicy, err := StarterPolicy(starterConfig)
	if err != nil {
		r.Close()
		return nil, err
	}
	pricing := ipricing.Pricing{Current: func() *rulebook.Rulebook { return rb }, Clock: time.Now}
	workshop, err := inv.New(is, pricing, invAuth)
	if err != nil {
		r.Close()
		return nil, err
	}
	r.Collection = ilocal.CollectionClient{Service: inv.CollectionService{Store: is, Authorizer: invAuth, StarterPolicy: starterPolicy, Rulebook: func() *rulebook.Rulebook { return rb }, Clock: time.Now, Seed: func() (uint64, error) {
		var b [4]byte
		_, err := rand.Read(b[:])
		return uint64(binary.BigEndian.Uint32(b[:])), err
	}}}
	r.Workshop = ilocal.WorkshopClient{Service: workshop, Catalog: inv.Catalog{Reader: is, Policy: pricing, Authorizer: invAuth}}
	r.Wallet = wlocal.Reader{Service: wallet.Reader{Store: ws, Authorizer: policy, Producer: "player-api"}, Assets: append([]string(nil), assets...)}
	r.Ledger = r.Wallet
	r.Guard = Guard{Inventory: is, Wallet: ws}
	participant, err := wallet.New(ws, policy, time.Now)
	if err != nil {
		r.Close()
		return nil, err
	}
	client, err := wlocal.New(participant, "inventory")
	if err != nil {
		r.Close()
		return nil, err
	}
	scoped, err := ws.EventsFor("inventory")
	if err != nil {
		r.Close()
		return nil, err
	}
	var token [12]byte
	if _, err = rand.Read(token[:]); err != nil {
		r.Close()
		return nil, err
	}
	owner := "api-" + hex.EncodeToString(token[:])
	r.worker = inv.Worker{Store: is, Authorizer: invAuth, Settlement: bridge.Settlement{Client: client, Treasury: bridge.DefaultBuybackTreasury}, Service: workshop, Owner: owner, Clock: time.Now, Lease: 30 * time.Second, Limit: 64}
	r.dispatcher = wallet.Dispatcher{Store: scoped, Publisher: events.Publisher{Sink: bridge.Receiver{Service: workshop, Producer: "inventory", Treasury: bridge.DefaultBuybackTreasury, Principal: inv.Principal{Kind: "service", ID: WalletEventsPrincipal}}}, Owner: owner, Clock: time.Now, Lease: 30 * time.Second, Limit: 64}
	if err = r.Guard.Check(ctx); err != nil {
		r.Close()
		return nil, err
	}
	return r, nil
}

// Run resumes durable work outside HTTP requests. A standalone worker may also run;
// delivery leases and fencing make concurrent consumers safe.
func (r *Runtime) Run(ctx context.Context) {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		pass, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := r.Guard.Check(pass)
		if err == nil {
			_, workErr := r.worker.RunOnce(ServiceContext(pass, WorkerPrincipal))
			_, deliveryErr := r.dispatcher.RunOnce(pass)
			err = errors.Join(workErr, deliveryErr)
		}
		cancel()
		if err != nil && ctx.Err() == nil {
			log.Print("Economy delivery deferred; durable work will retry")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
