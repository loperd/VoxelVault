package httpapi

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/voxel-vault/api/internal/economyruntime"
	ipg "github.com/voxel-vault/api/inventory/adapters/postgres"
	pricing "github.com/voxel-vault/api/inventory/adapters/rulebook"
	inv "github.com/voxel-vault/api/inventory/application"
	iv1 "github.com/voxel-vault/api/inventory/contracts/v1"
	"github.com/voxel-vault/api/inventory/domain"
	"github.com/voxel-vault/api/inventory/domain/rulebook"
)

func forbiddenInventory(t *testing.T, err error) {
	t.Helper()
	var failure *iv1.Error
	if !errors.As(err, &failure) || failure.Code != iv1.Forbidden {
		t.Fatalf("expected inventory forbidden, got %v", err)
	}
}

func TestInventoryDirectPortsRequireIdentityRoleAndOwnerScope(t *testing.T) {
	f := httpStack(t, true)
	ctx := context.Background()
	_, err := f.runtime.Collection.Items(ctx, "alice")
	forbiddenInventory(t, err)
	_, err = f.runtime.Collection.Items(inv.WithLifecycleInitiator(ctx, "alice"), "alice")
	forbiddenInventory(t, err)
	alice := f.runtime.UserContext(ctx, "alice")
	if _, err = f.runtime.Collection.Items(alice, "alice"); err != nil {
		t.Fatal(err)
	}
	_, err = f.runtime.Collection.Items(alice, "bob")
	forbiddenInventory(t, err)
	_, err = f.runtime.Workshop.Start(alice, "bob", "cross-owner", "bob-item", "sell")
	forbiddenInventory(t, err)
	_, err = f.runtime.Collection.Issue(alice, iv1.IssueRequest{Owner: "alice", RequestID: "unauthorized-mint", Type: "ender", Source: "admin", Count: 1})
	forbiddenInventory(t, err)
	if err = f.runtime.Collection.GrantStarter(alice, "alice", []iv1.Grant{{Type: "ender", Count: 100}}); err == nil {
		t.Fatal("caller changed server starter plan")
	}
	if _, err = f.acl.AddGroupingPolicy("alice", "admin"); err != nil {
		t.Fatal(err)
	}
	_, err = f.runtime.Collection.Issue(alice, iv1.IssueRequest{Owner: "bob", RequestID: "admin-grant", Type: "ender", Source: "admin", Count: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.runtime.Collection.Issue(alice, iv1.IssueRequest{Owner: "bob", RequestID: "spoof-starter", Type: "ender", Source: "starter", Count: 1})
	forbiddenInventory(t, err)
	// The domain gate reads current assignments, without relying on the HTTP
	// enforcer's role cache or another request passing through middleware.
	httpExec(t, f.source, `DELETE FROM security.role_bindings WHERE subject='alice'`)
	_, err = f.runtime.Collection.Items(alice, "alice")
	forbiddenInventory(t, err)
	decodeResponse(t, f.request("GET", "/api/v1/inventory/items", "alice", "", ""), 403, nil)
}

func TestInventoryServicePermissionsRequireExactOperationDelegation(t *testing.T) {
	f := httpStack(t, true)
	auth, err := economyruntime.InventoryAuthorizer(f.source)
	if err != nil {
		t.Fatal(err)
	}
	service, err := inv.New(ipg.New(f.idb), pricing.Pricing{Current: func() *rulebook.Rulebook { return f.rb }, Clock: time.Now}, auth)
	if err != nil {
		t.Fatal(err)
	}
	fact := domain.SettlementFact{IntentID: "missing-operation", Version: 1}
	alice := f.runtime.UserContext(context.Background(), "alice")
	if err = service.Observe(alice, "forbidden-observation", fact); !errors.Is(err, inv.ErrForbidden) {
		t.Fatal(err)
	}
	wallet := economyruntime.ServiceContext(context.Background(), economyruntime.WalletEventsPrincipal)
	if err = service.Observe(wallet, "missing-delegation", fact); !errors.Is(err, inv.ErrForbidden) {
		t.Fatal(err)
	}
	wrong := inv.WithOperationScope(wallet, "another-operation")
	if err = service.Observe(wrong, "wrong-delegation", fact); !errors.Is(err, inv.ErrForbidden) {
		t.Fatal(err)
	}
	bound := inv.WithOperationScope(wallet, fact.IntentID)
	if err = service.Reconcile(bound, fact.IntentID, "not-wallet-authority"); !errors.Is(err, inv.ErrForbidden) {
		t.Fatal(err)
	}
	if err = service.Observe(bound, "authorized-missing-operation", fact); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("scoped service request failed at wrong boundary", err)
	}
	httpExec(t, f.source, `INSERT INTO security.role_bindings(subject,role) VALUES('wallet-events','wallet-settlement')`)
	spoofed := inv.WithOperationScope(f.runtime.UserContext(context.Background(), economyruntime.WalletEventsPrincipal), fact.IntentID)
	if err = service.Observe(spoofed, "user-is-not-service", fact); !errors.Is(err, inv.ErrForbidden) {
		t.Fatal(err)
	}
	worker := inv.Worker{Authorizer: auth}
	if _, err = worker.RunOnce(alice); !errors.Is(err, inv.ErrForbidden) {
		t.Fatal("user entered delivery queue", err)
	}
	var inbox int
	if err = f.idb.QueryRow(`SELECT count(*) FROM inventory.inbox`).Scan(&inbox); err != nil || inbox != 0 {
		t.Fatal("denied operation committed inbox state", inbox, err)
	}
}
