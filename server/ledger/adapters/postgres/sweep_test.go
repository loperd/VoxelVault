package postgres_test

import (
	"testing"
	"time"

	"github.com/voxel-vault/api/ledger/domain"
)

func TestTaxSweepMovesEverythingOncePerWindowAndNeedsOpenAccounts(t *testing.T) {
	db, store := database(t)
	window, at := time.Date(2026, 10, 28, 5, 0, 0, 0, time.UTC), time.Date(2026, 10, 28, 5, 30, 0, 0, time.UTC)
	if _, err := store.SweepTreasury(ctx, "platform-tax", "treasury", "coins", window, at); err == nil {
		t.Fatal("sweeping unopened accounts must fail")
	}
	for _, name := range []string{"platform-tax", "treasury"} {
		if err := store.OpenAccount(ctx, domain.TreasuryAccount(name, "coins")); err != nil {
			t.Fatal(err)
		}
	}
	if n, err := store.SweepTreasury(ctx, "platform-tax", "treasury", "coins", window, at); err != nil || n != 0 {
		t.Fatalf("nothing to sweep: %d %v", n, err)
	}
	tax := domain.TreasuryAccount("platform-tax", "coins")
	if _, err := db.Exec(`INSERT INTO ledger.intents(producer,id) VALUES('t','seed')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO ledger.accounts(id,subject,asset,role) VALUES('x','equity','coins','opening_equity')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO ledger.journals(id,producer,intent_id,asset,occurred_at) VALUES('seed','t','seed','coins',now())`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO ledger.postings(journal_id,ordinal,account_id,asset,side,units) VALUES('seed',0,$1,'coins','credit',7),('seed',1,'x','coins','debit',7)`, tax.ID); err != nil {
		t.Fatal(err)
	}
	if n, err := store.SweepTreasury(ctx, "platform-tax", "treasury", "coins", window, at); err != nil || n != 7 {
		t.Fatalf("sweep: %d %v", n, err)
	}
	if n, err := store.SweepTreasury(ctx, "platform-tax", "treasury", "coins", window, at); err != nil || n != 0 {
		t.Fatalf("the same window must not sweep twice: %d %v", n, err)
	}
	if f, err := store.Balance(ctx, "treasury", "coins"); err != nil || f.Posted != 0 {
		t.Fatalf("balance reads player accounts only: %v %v", f, err)
	}
	var posted int64
	if err := db.QueryRow(`SELECT sum(CASE side WHEN 'credit' THEN units ELSE -units END) FROM ledger.postings WHERE account_id=$1`, domain.TreasuryAccount("treasury", "coins").ID).Scan(&posted); err != nil || posted != 7 {
		t.Fatalf("treasury holds %d: %v", posted, err)
	}
}
