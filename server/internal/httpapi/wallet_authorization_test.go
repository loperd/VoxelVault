package httpapi

import (
	"context"
	"errors"
	"testing"

	wallet "github.com/voxel-vault/api/ledger/application"
	v1 "github.com/voxel-vault/api/ledger/contracts/v1"
)

func forbiddenWallet(t *testing.T, err error) {
	t.Helper()
	var failure *v1.Error
	if !errors.As(err, &failure) || failure.Code != v1.Forbidden {
		t.Fatalf("expected Wallet forbidden, got %v", err)
	}
}

func TestWalletDirectPortsRequireFreshRoleVerifiedIdentityAndOwner(t *testing.T) {
	f := httpStack(t, true)
	ctx := context.Background()
	_, err := f.runtime.Wallet.Balances(ctx, "alice")
	forbiddenWallet(t, err)
	alice := f.runtime.UserContext(ctx, "alice")
	if _, err = f.runtime.Wallet.Balances(alice, "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err = f.runtime.Wallet.History(alice, "alice", "currency", "", 10); err != nil {
		t.Fatal(err)
	}
	_, err = f.runtime.Wallet.Balances(alice, "bob")
	forbiddenWallet(t, err)
	_, err = f.runtime.Wallet.History(alice, "bob", "currency", "", 10)
	forbiddenWallet(t, err)
	service := wallet.WithAuthenticatedPrincipal(ctx, wallet.Principal{Kind: "service", ID: "alice"})
	_, err = f.runtime.Wallet.Balances(service, "alice")
	forbiddenWallet(t, err)
	_, err = f.runtime.Wallet.Balances(f.runtime.UserContext(ctx, "unassigned"), "unassigned")
	forbiddenWallet(t, err)
	// Keep the HTTP enforcer's cached role intact; the context gate must revoke it.
	httpExec(t, f.source, `DELETE FROM security.role_bindings WHERE subject='alice'`)
	_, err = f.runtime.Wallet.Balances(alice, "alice")
	forbiddenWallet(t, err)
	_, err = f.runtime.Wallet.History(alice, "alice", "currency", "", 10)
	forbiddenWallet(t, err)
	decodeResponse(t, f.request("GET", "/api/v1/wallet", "alice", "", ""), 403, nil)
	decodeResponse(t, f.request("GET", "/api/v1/wallet/transactions", "alice", "", ""), 403, nil)
}
