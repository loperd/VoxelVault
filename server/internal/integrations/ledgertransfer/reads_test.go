package ledgertransfer

import (
	"context"
	"errors"
	cv1 "github.com/voxel-vault/api/internal/currency/contracts/v1"
	lv1 "github.com/voxel-vault/api/internal/ledger/contracts/v1"
	"testing"
)

type historyFixture struct {
	history, first []lv1.HistoryEntry
	balance        []lv1.AssetBalance
	err            error
}

func (f historyFixture) Balances(context.Context, string) ([]lv1.AssetBalance, error) {
	return f.balance, f.err
}
func (f historyFixture) History(_ context.Context, subject, _, cursor string, _ int) (lv1.History, error) {
	if subject != "owner" {
		return lv1.History{}, &lv1.Error{Code: lv1.Forbidden}
	}
	if f.err != nil {
		return lv1.History{}, f.err
	}
	if cursor != "" {
		return lv1.History{}, nil
	}
	return lv1.History{Entries: append(f.first, f.history...)}, nil
}

type currencyFixture struct {
	cv1.Provider
	read bool
	err  error
}

func (f currencyFixture) Decide(context.Context, string, string) (cv1.AccessDecision, error) {
	return cv1.AccessDecision{CanRead: f.read}, f.err
}
func TestHistoryCurrencyVisibilityPreservesRevokedHoldingsAndHistory(t *testing.T) {
	for _, tc := range []struct {
		name    string
		ledger  historyFixture
		read    bool
		cursor  string
		allowed bool
	}{
		{name: "current eligibility", read: true, allowed: true},
		{name: "never eligible", allowed: false},
		{name: "revoked positive balance", ledger: historyFixture{balance: []lv1.AssetBalance{{Asset: "coins", Posted: "10", Held: "0"}}}, allowed: true},
		{name: "revoked active hold", ledger: historyFixture{balance: []lv1.AssetBalance{{Asset: "coins", Posted: "10", Held: "10"}}}, allowed: true},
		{name: "revoked historical row", ledger: historyFixture{history: []lv1.HistoryEntry{{ID: "journal"}}}, allowed: true},
		{name: "revoked empty last page", ledger: historyFixture{first: []lv1.HistoryEntry{{ID: "journal"}}}, cursor: "last", allowed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := HistoryReader{Ledger: tc.ledger, Currency: currencyFixture{read: tc.read}}
			_, err := r.History(context.Background(), "owner", "coins", tc.cursor, 25)
			if (err == nil) != tc.allowed {
				t.Fatal(err)
			}
		})
	}
	r := HistoryReader{Ledger: historyFixture{}, Currency: currencyFixture{read: true}}
	if _, err := r.History(context.Background(), "other", "coins", "", 25); err == nil {
		t.Fatal("currency access bypassed owner authorization")
	}
	failure := errors.New("currency unavailable")
	r.Currency = currencyFixture{err: failure}
	if _, err := r.History(context.Background(), "owner", "coins", "", 25); !errors.Is(err, failure) {
		t.Fatal(err)
	}
}
