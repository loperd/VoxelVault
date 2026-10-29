package postgres_test

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	fees "github.com/voxel-vault/api/commissions/domain"
	"github.com/voxel-vault/api/ledger/adapters/postgres"
	"github.com/voxel-vault/api/ledger/application"
	"github.com/voxel-vault/api/ledger/domain"
)

// Candidate 1: Confirm's tx starts, operator Restrict commits, then Confirm takes locks.
func TestRestrictionCommittedAfterConfirmStartIsHonoured(t *testing.T) {
	for _, kind := range []string{"send", "receive"} {
		db, s, actor := restrictionService(t)
		acct := domain.PlayerAccount(domain.Terms{Subject: "player", Asset: "coins"}).ID
		if kind == "receive" {
			acct = domain.PlayerAccount(domain.Terms{Subject: "recipient", Asset: "coins"}).ID
		}
		q, err := s.Quote(actor, "coins", "recipient", "100")
		if err != nil {
			t.Fatal(err)
		}
		stall, _ := db.Begin()
		if _, err = stall.Exec(`SELECT 1 FROM ledger.transfer_quotes WHERE id=$1 FOR UPDATE`, q.ID); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { _, e := s.Confirm(actor, q.ID, "k1"); done <- e }()
		time.Sleep(700 * time.Millisecond) // Confirm tx is open, blocked on the quote lock
		if _, err = postgres.New(db).Restrict(ctx, acct, kind, "audit", "ops", nil); err != nil {
			t.Fatal(err)
		}
		stall.Rollback()
		cerr := <-done
		var journal, active int
		db.QueryRow(`SELECT count(*) FROM ledger.transfer_commands WHERE receipt IS NOT NULL`).Scan(&journal)
		db.QueryRow(`SELECT count(*) FROM ledger.account_restrictions WHERE lifted_at IS NULL`).Scan(&active)
		t.Logf("%s restriction committed before Confirm locks: confirm err=%v completed_transfers=%d active_restrictions=%d", kind, cerr, journal, active)
		// control: the same restriction blocks a transfer whose tx starts afterwards
		cerr2 := transferOnce(db, s, actor, "k2")
		if cerr == nil || journal != 0 {
			t.Fatalf("%s: transfer passed a restriction committed before its locks: err=%v completed=%d", kind, cerr, journal)
		}
		t.Logf("%s control (new tx after restriction): err=%v", kind, cerr2)
	}
}

type multiFee map[string]feeCalculator

func (m multiFee) CalculateTransfer(c context.Context, f application.TransferFact) (application.CommissionPlan, error) {
	return m[f.CurrencyID].CalculateTransfer(c, f)
}

type anyAssetAuth struct{}

func (anyAssetAuth) AuthorizeTransfer(c context.Context, subject, _ string) error {
	if p, ok := application.AuthenticatedPrincipal(c); !ok || p.ID != subject {
		return application.ErrForbidden
	}
	return nil
}

// Candidate 2: cap 10/min; 9 completed; two confirms in two currencies run concurrently.
// A BEFORE INSERT trigger on journals (sleep) only widens the count->commit window.
func TestBurstCapHoldsAcrossCurrencies(t *testing.T) {
	for _, sleep := range []string{"0.5", "ctl"} {
		db, store := database(t)
		assets := []string{"coins", "coins2"}
		quoteAssets := assets
		if sleep == "ctl" { // one currency: same sender account lock serializes
			sleep, quoteAssets = "0.5", []string{"coins", "coins"}
		}
		fee := multiFee{}
		for _, a := range assets {
			c := command("fund-"+a, "fund-"+a, domain.Credit, 1000)
			c.Terms.Asset = a
			execute(t, openService(t, store), c)
			dest := domain.TreasuryAccount("tax", a)
			if err := store.OpenAccount(ctx, dest); err != nil {
				t.Fatal(err)
			}
			fee[a] = feeCalculator{fees.Rule{ID: "tax", Version: "1", GeneralTax: true, Imposition: fees.Inside, Numerator: 1, Denominator: 100,
				Destination: []fees.Destination{{Account: dest.ID, Weight: 1}}}}
		}
		var seq atomic.Int64
		s, err := application.NewTransfer(store, &transferAccess{}, transferRecipient{}, fee, anyAssetAuth{}, time.Now,
			func() (string, error) { return fmt.Sprintf("quote-%d", seq.Add(1)), nil })
		if err != nil {
			t.Fatal(err)
		}
		actor := application.WithAuthenticatedPrincipal(ctx, application.Principal{Kind: "user", ID: "player"})
		for i := 0; i < 9; i++ {
			if _, err = db.Exec(`INSERT INTO ledger.transfer_commands(subject,id,fingerprint,receipt) VALUES('player',$1,'x','{}')`, fmt.Sprint("prime", i)); err != nil {
				t.Fatal(err)
			}
		}
		var q [2]application.TransferQuote
		for i, a := range quoteAssets {
			if q[i], err = s.Quote(actor, a, "recipient", "100"); err != nil {
				t.Fatal(a, err)
			}
		}
		var name string
		db.QueryRow(`SELECT current_database()`).Scan(&name)
		adminURL, err := url.Parse(os.Getenv("TEST_WALLET_DATABASE_URL"))
		if err != nil {
			t.Fatal(err)
		}
		adminURL.Path = "/" + name
		admin, _ := sql.Open("pgx", adminURL.String())
		if _, err = admin.Exec(`CREATE FUNCTION ledger.zz_sleep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(` + sleep + `); RETURN NEW; END $$;
			CREATE TRIGGER zz BEFORE INSERT ON ledger.journals FOR EACH ROW EXECUTE FUNCTION ledger.zz_sleep()`); err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		var errs [2]error
		for i := range q {
			wg.Add(1)
			go func() { defer wg.Done(); _, errs[i] = s.Confirm(actor, q[i].ID, fmt.Sprint("k", i)) }()
		}
		wg.Wait()
		var n int
		db.QueryRow(`SELECT count(*) FROM ledger.transfer_commands WHERE subject='player' AND receipt IS NOT NULL AND created_at>now()-interval '1 minute'`).Scan(&n)
		t.Logf("assets=%v sleep=%s confirm errs=%v / %v; completed in last minute=%d (cap 10); active send blocks=%s", quoteAssets, sleep, errs[0], errs[1], n, blocks(db))
		admin.Close()
		if n != 10 {
			t.Fatalf("%v: %d transfers completed in a minute, cap is 10", quoteAssets, n)
		}
	}
}

func blocks(db *sql.DB) string {
	var n int
	db.QueryRow(`SELECT count(*) FROM ledger.account_restrictions WHERE lifted_at IS NULL`).Scan(&n)
	return fmt.Sprint(n)
}

func openService(t *testing.T, store application.Store) *application.Service {
	a := authorizer(func(_ context.Context, p string, _ domain.Action, _ *domain.Terms) error {
		if p != "inventory" {
			return application.ErrForbidden
		}
		return nil
	})
	s, err := application.New(store, a, func() time.Time { return time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC) })
	if err != nil {
		t.Fatal(err)
	}
	return s
}
