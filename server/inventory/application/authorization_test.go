package application_test

import (
	"context"
	"errors"
	"testing"
	"time"

	inv "github.com/voxel-vault/api/inventory/application"
	"github.com/voxel-vault/api/inventory/domain"
	"github.com/voxel-vault/api/inventory/domain/rulebook"
)

type authFunc func(context.Context, inv.AccessRequest) (inv.Decision, error)

func (f authFunc) Authorize(c context.Context, r inv.AccessRequest) (inv.Decision, error) {
	return f(c, r)
}

type untouchedStore struct{}

func (untouchedStore) Transact(context.Context, func(inv.Tx) error) error {
	panic("unauthorized transaction")
}
func (untouchedStore) Operation(context.Context, string, string) (domain.Operation, error) {
	panic("unauthorized operation read")
}
func (untouchedStore) Collection(context.Context, func(inv.CollectionTx) error) error {
	panic("unauthorized collection transaction")
}
func (untouchedStore) Items(context.Context, string) ([]domain.Item, error) {
	panic("unauthorized item read")
}
func (untouchedStore) ImportItems(context.Context, inv.Opening) error {
	panic("unauthorized item import")
}
func (untouchedStore) ImportChests(context.Context, inv.ChestsOpening) error {
	panic("unauthorized chest import")
}
func (untouchedStore) Quote(domain.Item, domain.Action) (domain.Quote, error) {
	panic("unauthorized pricing")
}
func (untouchedStore) Offers([]domain.Item) map[string]inv.Offers { panic("unauthorized catalog") }

func TestAllInventoryUseCasesDenyBeforeIO(t *testing.T) {
	store := untouchedStore{}
	deny := authFunc(func(context.Context, inv.AccessRequest) (inv.Decision, error) {
		return inv.Decision{}, inv.ErrForbidden
	})
	service, err := inv.New(store, store, deny)
	if err != nil {
		t.Fatal(err)
	}
	collection := inv.CollectionService{Store: store, Authorizer: deny, StarterPolicy: func([]inv.Grant) bool { return true }, Rulebook: func() *rulebook.Rulebook { panic("unauthorized rulebook") }, Clock: time.Now, Seed: func() (uint64, error) { panic("unauthorized RNG") }}
	catalog := inv.Catalog{Reader: store, Policy: store, Authorizer: deny}
	ctx := inv.WithAuthenticatedPrincipal(context.Background(), inv.Principal{Kind: "user", ID: "alice"})
	cases := map[string]func() error{
		"repair": func() error {
			_, e := service.Start(ctx, inv.Request{Owner: "alice", ItemID: "item", RequestID: "request", Action: domain.Repair})
			return e
		},
		"sell": func() error {
			_, e := service.Start(ctx, inv.Request{Owner: "alice", ItemID: "item", RequestID: "request", Action: domain.Sell})
			return e
		},
		"salvage": func() error {
			_, e := service.Start(ctx, inv.Request{Owner: "alice", ItemID: "item", RequestID: "request", Action: domain.Salvage})
			return e
		},
		"cancel":    func() error { _, e := service.Cancel(ctx, "alice", "operation"); return e },
		"operation": func() error { _, e := service.Operation(ctx, "alice", "operation"); return e },
		"observe":   func() error { return service.Observe(ctx, "message", domain.SettlementFact{IntentID: "operation"}) },
		"reconcile": func() error { return service.Reconcile(ctx, "operation", "reason") },
		"items":     func() error { _, e := collection.Items(ctx, "alice"); return e },
		"catalog":   func() error { _, e := catalog.Items(ctx, "alice"); return e },
		"chests":    func() error { _, e := collection.Chests(ctx, "alice"); return e },
		"issue":     func() error { _, e := collection.Issue(ctx, inv.IssueRequest{Owner: "alice"}); return e },
		"starter":   func() error { return collection.GrantStarter(ctx, "alice", nil) },
		"claim":     func() error { _, _, e := collection.Claim(ctx, "alice", "chest", "session"); return e },
		"open":      func() error { _, e := collection.Open(ctx, "alice", "chest", "session"); return e },
		"merge-chests": func() error {
			_, e := collection.MergeChests(ctx, inv.PairRequest{Owner: "alice", A: "a", B: "b"})
			return e
		},
		"merge-items": func() error {
			_, e := collection.MergeItems(ctx, inv.PairRequest{Owner: "alice", A: "a", B: "b"})
			return e
		},
		"odds": func() error { _, e := collection.MergeOdds(ctx, "alice", "a", "b"); return e },
		"item-import": func() error {
			return (inv.OpeningService{Store: store, Authorizer: deny}).Import(ctx, inv.Opening{Source: "source"})
		},
		"chest-import": func() error {
			return (inv.ChestsOpeningService{Store: store, Authorizer: deny}).Import(ctx, inv.ChestsOpening{Source: "source"})
		},
	}
	for name, call := range cases {
		t.Run(name, func(t *testing.T) {
			if err := call(); !errors.Is(err, inv.ErrForbidden) {
				t.Fatal(err)
			}
		})
	}
	if _, err := inv.New(store, store, nil); !errors.Is(err, inv.ErrForbidden) {
		t.Fatal("missing authorizer accepted", err)
	}
}

func TestInventoryAuthorizationErrorsAndMissingIdentityFailClosed(t *testing.T) {
	store := untouchedStore{}
	for name, auth := range map[string]inv.Authorizer{
		"unavailable": authFunc(func(context.Context, inv.AccessRequest) (inv.Decision, error) {
			return inv.Decision{}, errors.New("policy backend unavailable")
		}),
		"unversioned": authFunc(func(context.Context, inv.AccessRequest) (inv.Decision, error) { return inv.Decision{}, nil }),
	} {
		t.Run(name, func(t *testing.T) {
			service, err := inv.New(store, store, auth)
			if err != nil {
				t.Fatal(err)
			}
			ctx := inv.WithAuthenticatedPrincipal(context.Background(), inv.Principal{Kind: "user", ID: "alice"})
			_, err = service.Operation(ctx, "alice", "op")
			if !errors.Is(err, inv.ErrAuthorizationUnavailable) {
				t.Fatal(err)
			}
		})
	}
	allow := authFunc(func(context.Context, inv.AccessRequest) (inv.Decision, error) {
		panic("missing principal reached policy")
	})
	service, _ := inv.New(store, store, allow)
	if _, err := service.Operation(context.Background(), "alice", "op"); !errors.Is(err, inv.ErrForbidden) {
		t.Fatal(err)
	}
	if _, err := (inv.Catalog{Reader: store, Policy: store}).Items(context.Background(), "alice"); !errors.Is(err, inv.ErrForbidden) {
		t.Fatal(err)
	}
}
