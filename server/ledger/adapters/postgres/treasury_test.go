package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/voxel-vault/api/ledger/adapters/authorization"
	"github.com/voxel-vault/api/ledger/adapters/postgres"
	"github.com/voxel-vault/api/ledger/application"
	"github.com/voxel-vault/api/ledger/domain"
)

func treasuryServices(t *testing.T, store *postgres.Store) (*application.Service, application.TreasuryOpeningService) {
	t.Helper()
	policy, err := authorization.New([]authorization.Grant{
		{Producer: "inventory", Actions: []domain.Action{domain.Payout, domain.ClosePayout, domain.Credit, application.ReadCapability}, Assets: []string{"coins", "ore"}, AllSubjects: true, Purposes: []domain.Purpose{domain.Buyback, domain.Reward}, Treasuries: []string{"buyback"}, Scopes: []authorization.ResourceScope{{Purpose: domain.Buyback, Assets: []string{"coins"}}, {Purpose: domain.Reward, Assets: []string{"ore"}}}},
		{Producer: "funding", Actions: []domain.Action{domain.FundTreasury}, MaxUnits: 100, Assets: []string{"coins"}, Subjects: []string{"system"}, Purposes: []domain.Purpose{domain.TreasuryOpening}, Treasuries: []string{"buyback"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	s, err := application.New(store, policy, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.OpenAccount(ctx, domain.TreasuryAccount("buyback", "coins")); err != nil {
		t.Fatal(err)
	}
	return s, application.TreasuryOpeningService{Store: store, Authorizer: fixtureIssuance{policy}, Producer: "funding", Clock: time.Now}
}

func allocation(units int64) application.TreasuryOpening {
	return application.TreasuryOpening{Treasury: "buyback", Asset: "coins", Units: units, Source: "approved-allocation", Reference: "allocation-1"}
}

func payout(id, subject string, units int64) application.Command {
	return application.Command{Producer: "inventory", ID: id, IntentID: id, Action: domain.Payout, Terms: &domain.Terms{Subject: subject, Asset: "coins", Units: units, Purpose: domain.Buyback, Treasury: "buyback", Evidence: "quote-" + id}}
}

func TestFundedPayoutConservesLiabilitiesAndOpeningCannotRefill(t *testing.T) {
	db, store := operatorDatabase(t)
	s, opening := treasuryServices(t, store)
	first, err := opening.Open(ctx, allocation(8))
	if err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 2; n++ {
		c := payout(fmt.Sprint(n), "player", 4)
		r := execute(t, s, c)
		if r.Intent.State != domain.Credited {
			t.Fatal(r)
		}
		execute(t, s, c)
		c.ID += "-retry"
		execute(t, s, c)
	}
	funds(t, store, 8, 0)
	r := execute(t, s, payout("exhausted", "player", 1))
	if r.Intent.State != domain.Rejected || r.Intent.Reason != "insufficient_treasury_funds" {
		t.Fatal(r)
	}
	again, err := opening.Open(ctx, allocation(8))
	if err != nil || first.JournalID != again.JournalID {
		t.Fatal(again, err)
	}
	var treasury, total string
	if err := db.QueryRow(`SELECT COALESCE(sum(CASE p.side WHEN 'credit' THEN p.units::numeric ELSE -p.units::numeric END),0)::text FROM ledger.postings p JOIN ledger.accounts a ON a.id=p.account_id WHERE a.role='treasury_liability'`).Scan(&treasury); err != nil || treasury != "0" {
		t.Fatal(treasury, err)
	}
	if err := db.QueryRow(`SELECT sum(CASE p.side WHEN 'credit' THEN p.units::numeric ELSE -p.units::numeric END)::text FROM ledger.postings p JOIN ledger.accounts a ON a.id=p.account_id WHERE a.role IN ('treasury_liability','player_liability')`).Scan(&total); err != nil || total != "8" {
		t.Fatal(total, err)
	}
	changed := allocation(9)
	if _, err := opening.Open(ctx, changed); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("opening amount changed", err)
	}
	changed = allocation(8)
	changed.Reference = "another-reference"
	if _, err := opening.Open(ctx, changed); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("opening source changed", err)
	}
	if count(t, db, "journals") != 3 {
		t.Fatal("duplicate payout/opening journal")
	}
	var expense int
	if err := db.QueryRow(`SELECT count(*) FROM ledger.accounts WHERE role='reward_expense'`).Scan(&expense); err != nil || expense != 0 {
		t.Fatal("buyback used issuance account", expense, err)
	}
}

func TestConcurrentPayoutsCannotOverdrawTreasury(t *testing.T) {
	db, store := operatorDatabase(t)
	s, opening := treasuryServices(t, store)
	if _, err := opening.Open(ctx, allocation(10)); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan application.Receipt, 40)
	failures := make(chan error, 40)
	for n := range 40 {
		wg.Go(func() {
			r, err := s.Execute(ctx, payout(fmt.Sprint(n), fmt.Sprint("player-", n), 1))
			if err != nil {
				failures <- err
			} else {
				results <- r
			}
		})
	}
	wg.Wait()
	close(results)
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	paid, rejected := 0, 0
	for r := range results {
		switch r.Intent.State {
		case domain.Credited:
			paid++
		case domain.Rejected:
			rejected++
		default:
			t.Fatal(r)
		}
	}
	if paid != 10 || rejected != 30 || count(t, db, "journals") != 11 {
		t.Fatal(paid, rejected)
	}
	var negative int
	if err := db.QueryRow(`SELECT count(*) FROM (SELECT a.id FROM ledger.accounts a LEFT JOIN ledger.postings p ON p.account_id=a.id WHERE a.role IN ('treasury_liability','player_liability') GROUP BY a.id HAVING COALESCE(sum(CASE p.side WHEN 'credit' THEN p.units::numeric ELSE -p.units::numeric END),0)<0) x`).Scan(&negative); err != nil || negative != 0 {
		t.Fatal(negative, err)
	}
}

func TestPayoutFencesAndAuthorizationPreventUnfundedCredits(t *testing.T) {
	db, store := operatorDatabase(t)
	s, opening := treasuryServices(t, store)
	if _, err := opening.Open(ctx, allocation(101)); !errors.Is(err, application.ErrForbidden) {
		t.Fatal("allocation exceeded role budget", err)
	}
	closed := execute(t, s, application.Command{Producer: "inventory", ID: "close", IntentID: "late", Action: domain.ClosePayout})
	if closed.Intent.State != domain.Closed {
		t.Fatal(closed)
	}
	if _, err := opening.Open(ctx, allocation(4)); err != nil {
		t.Fatal(err)
	}
	r := execute(t, s, payout("late", "player", 4))
	if r.Intent.State != domain.Closed {
		t.Fatal("closed payout revived", r)
	}
	for _, mutate := range []func(*application.Command){
		func(c *application.Command) { c.Terms.Treasury = "foreign" },
		func(c *application.Command) { c.Terms.Asset = "ore" },
		func(c *application.Command) {
			c.Action = domain.Credit
			c.Terms.Treasury = ""
			c.Terms.Purpose = domain.Reward
		},
	} {
		c := payout("forbidden", "player", 1)
		mutate(&c)
		if _, err := s.Execute(ctx, c); !errors.Is(err, application.ErrForbidden) {
			t.Fatal("scope bypass", err)
		}
	}
	opening.Producer = "inventory"
	if _, err := opening.Open(ctx, allocation(4)); !errors.Is(err, application.ErrForbidden) {
		t.Fatal("runtime opened treasury", err)
	}
	if count(t, db, "journals") != 1 {
		t.Fatal("forbidden command posted money")
	}
}

func TestPayoutRecipientLimitDoesNotDebitTreasury(t *testing.T) {
	db, store := operatorDatabase(t)
	s, opening := treasuryServices(t, store)
	if _, err := opening.Open(ctx, allocation(4)); err != nil {
		t.Fatal(err)
	}
	execute(t, service(t, store), command("baseline", "baseline", domain.Credit, math.MaxInt64))
	r := execute(t, s, payout("too-large", "player", 1))
	if r.Intent.State != domain.Rejected || r.Intent.Reason != "balance_limit" {
		t.Fatal(r)
	}
	if count(t, db, "journals") != 2 {
		t.Fatal("rejected payout changed ledger")
	}
	if r := execute(t, s, payout("another-player", "other", 4)); r.Intent.State != domain.Credited {
		t.Fatal("rejected recipient consumed treasury", r)
	}
}

// Settlement tests use an explicit trusted fixture; issuance policy is tested separately.
type fixtureIssuance struct{ application.Authorizer }

func (fixtureIssuance) AuthorizeIssuance(context.Context, string, application.Issuance) error {
	return nil
}
