package domain_test

import (
	"errors"
	"github.com/voxel-vault/api/ledger/domain"
	"math"
	"testing"
	"time"
)

func terms() domain.Terms {
	return domain.Terms{Subject: "player", Asset: "coins", Units: 8, Purpose: domain.Spending, Evidence: "quote-1"}
}
func TestCancelAndCloseFenceDelayedCreates(t *testing.T) {
	for _, tc := range []struct {
		cancel, create domain.Action
		state          domain.State
	}{{domain.Cancel, domain.Reserve, domain.Canceled}, {domain.Close, domain.Credit, domain.Closed}} {
		i := domain.Intent{Producer: "inventory", ID: "operation", State: domain.Missing}
		fenced, changed, err := i.Apply(tc.cancel, nil, domain.Funds{})
		if err != nil || !changed {
			t.Fatal(fenced, err)
		}
		tr := terms()
		if tc.create == domain.Credit {
			tr.Purpose = domain.Reward
		}
		late, changed, err := fenced.Apply(tc.create, &tr, domain.Funds{Posted: 100})
		if err != nil || changed || late.State != tc.state || late.Terms != nil {
			t.Fatal(late, changed, err)
		}
	}
}
func TestFundsAndTerminalIntents(t *testing.T) {
	i := domain.Intent{Producer: "inventory", ID: "repair", State: domain.Missing}
	tr := terms()
	reserved, _, err := i.Apply(domain.Reserve, &tr, domain.Funds{Posted: 10})
	if err != nil {
		t.Fatal(err)
	}
	tr.Units = 1
	if reserved.Terms.Units != 8 {
		t.Fatal("intent borrowed caller's terms")
	}
	changed := *reserved.Terms
	changed.Units = 7
	if _, _, err := reserved.Apply(domain.Reserve, &changed, domain.Funds{Posted: 10, Held: 8}); !errors.Is(err, domain.ErrConflict) {
		t.Fatal(err)
	}
	captured, _, err := reserved.Apply(domain.Capture, nil, domain.Funds{Posted: 10, Held: 8})
	if err != nil || captured.State != domain.Captured {
		t.Fatal(captured, err)
	}
	canceled, changedAgain, err := captured.Apply(domain.Cancel, nil, domain.Funds{Posted: 2})
	if err != nil || changedAgain || canceled.State != domain.Captured {
		t.Fatal(canceled, err)
	}
	if _, _, err := i.Apply(domain.Capture, nil, domain.Funds{}); !errors.Is(err, domain.ErrNotReady) {
		t.Fatal(err)
	}
}
func TestInsufficientFundsOverflowAndInvalidState(t *testing.T) {
	tr := terms()
	i := domain.Intent{State: domain.Missing}
	declined, _, err := i.Apply(domain.Reserve, &tr, domain.Funds{Posted: 10, Held: 3})
	if err != nil || declined.State != domain.Declined {
		t.Fatal(declined, err)
	}
	retry, changed, err := declined.Apply(domain.Reserve, &tr, domain.Funds{Posted: 100})
	if err != nil || changed || retry.State != domain.Declined {
		t.Fatal(retry, err)
	}
	tr.Purpose = domain.Reward
	rejected, _, err := i.Apply(domain.Credit, &tr, domain.Funds{Posted: math.MaxInt64 - 7})
	if err != nil || rejected.State != domain.Rejected {
		t.Fatal(rejected, err)
	}
	for _, f := range []domain.Funds{{Posted: -1}, {Posted: 10, Held: 11}, {Posted: 10, Held: -1}} {
		if _, err := f.Available(); !errors.Is(err, domain.ErrInvariant) {
			t.Fatal(f, err)
		}
	}
}
func TestCanonicalUnits(t *testing.T) {
	for _, s := range []string{"0", "01", "-1", "+1", "1.0", "1e3", " 1", "1 ", "9223372036854775808", "١", ""} {
		if _, err := domain.ParseUnits(s); !errors.Is(err, domain.ErrInvalid) {
			t.Fatal(s, err)
		}
	}
	for _, s := range []string{"1", "9007199254740993", "9223372036854775807"} {
		if _, err := domain.ParseUnits(s); err != nil {
			t.Fatal(s, err)
		}
	}
	if domain.ValidID(string([]byte{255})) {
		t.Fatal("invalid UTF-8 accepted")
	}
}
func TestJournalRejectsUnbalancedMixedAssetsAndSelfPosting(t *testing.T) {
	tr := terms()
	i := domain.Intent{Producer: "inventory", ID: "repair", State: domain.Captured, Terms: &tr}
	j, err := domain.SettlementJournal(i, domain.Capture, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	bad := j
	bad.Postings = append([]domain.Posting(nil), j.Postings...)
	bad.Postings[0].Units--
	if bad.Validate() == nil {
		t.Fatal("unbalanced journal accepted")
	}
	bad = j
	bad.Postings = append([]domain.Posting(nil), j.Postings...)
	bad.Postings[0].Asset = "ore"
	if bad.Validate() == nil {
		t.Fatal("mixed assets accepted")
	}
	bad = j
	bad.Postings = append([]domain.Posting(nil), j.Postings...)
	bad.Postings[0].Account = bad.Postings[1].Account
	if bad.Validate() == nil {
		t.Fatal("single-account journal accepted")
	}
	if domain.Identity("a|b", "c") == domain.Identity("a", "b|c") {
		t.Fatal("ambiguous identity encoding")
	}
}
