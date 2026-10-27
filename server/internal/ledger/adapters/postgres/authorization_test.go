package postgres_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/voxel-vault/api/internal/economyruntime"
	"github.com/voxel-vault/api/internal/ledger/adapters/authorization"
	"github.com/voxel-vault/api/internal/ledger/application"
	"github.com/voxel-vault/api/internal/ledger/domain"
)

type observedStore struct {
	application.Store
	inside    atomic.Bool
	afterRead func()
}

func (s *observedStore) Transact(ctx context.Context, fn func(application.Tx) error) error {
	return s.Store.Transact(ctx, func(tx application.Tx) error {
		s.inside.Store(true)
		defer s.inside.Store(false)
		return fn(tx)
	})
}
func (s *observedStore) ReadIntent(ctx context.Context, producer, id string) (domain.Intent, error) {
	i, err := s.Store.ReadIntent(ctx, producer, id)
	if err == nil && s.afterRead != nil {
		f := s.afterRead
		s.afterRead = nil
		f()
	}
	return i, err
}

func TestSecurityDecisionsStayOutsideWalletTransactionAndRetriesAreReauthorized(t *testing.T) {
	db, store := database(t)
	policy, err := economyruntime.WalletAuthorizer(nil, []authorization.Grant{{Producer: "inventory", Actions: []domain.Action{domain.Credit, domain.Close, application.ReadCapability}, Assets: []string{"coins"}, Subjects: []string{"player"}, Purposes: []domain.Purpose{domain.Reward}}})
	if err != nil {
		t.Fatal(err)
	}
	wrapped := &observedStore{Store: store}
	revoked := false
	calls := 0
	auth := authorizer(func(c context.Context, p string, a domain.Action, tr *domain.Terms) error {
		if wrapped.inside.Load() {
			t.Fatal("Security was called inside Wallet SQL transaction")
		}
		calls++
		if revoked {
			return application.ErrForbidden
		}
		return policy.Authorize(c, p, a, tr)
	})
	s, err := application.New(wrapped, auth, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	c := command("credit", "credit", domain.Credit, 3)
	execute(t, s, c)
	execute(t, s, c)
	if _, err = s.Status(ctx, "inventory", "credit"); err != nil {
		t.Fatal(err)
	}
	if calls < 6 {
		t.Fatal("missing entry decisions", calls)
	}
	revoked = true
	if _, err = s.Execute(ctx, c); !errors.Is(err, application.ErrForbidden) {
		t.Fatal("replay ignored revocation", err)
	}
	if count(t, db, "journals") != 1 {
		t.Fatal("replayed credit posted twice")
	}
	funds(t, store, 3, 0)
}

func TestConcurrentFirstTermsRequireFreshDecisionBeforeClosing(t *testing.T) {
	db, store := database(t)
	writer := service(t, store)
	wrapped := &observedStore{Store: store}
	wrapped.afterRead = func() { execute(t, writer, command("concurrent-credit", "scope-race", domain.Credit, 4)) }
	// A closer can enter an unseen intent, but lacks the newly established asset scope.
	auth := authorizer(func(_ context.Context, _ string, _ domain.Action, tr *domain.Terms) error {
		if wrapped.inside.Load() {
			t.Fatal("authorization inside transaction")
		}
		if tr != nil {
			return application.ErrForbidden
		}
		return nil
	})
	closer, err := application.New(wrapped, auth, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = closer.Execute(ctx, command("close", "scope-race", domain.Close, 0)); !errors.Is(err, application.ErrForbidden) {
		t.Fatal("new terms bypassed authorization", err)
	}
	if count(t, db, "commands") != 1 || count(t, db, "outbox") != 1 {
		t.Fatal("denied closure committed state")
	}
	funds(t, store, 4, 0)
}

func TestSecurityOutagePrecedesEveryFinancialWrite(t *testing.T) {
	db, store := database(t)
	offline := errors.New("Security unavailable")
	s, err := application.New(store, authorizer(func(context.Context, string, domain.Action, *domain.Terms) error { return offline }), time.Now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Execute(ctx, command("credit", "credit", domain.Credit, 3)); !errors.Is(err, offline) {
		t.Fatal(err)
	}
	for _, table := range []string{"commands", "intents", "accounts", "journals", "postings", "outbox"} {
		if count(t, db, table) != 0 {
			t.Fatal("outage committed financial state", table)
		}
	}
}
