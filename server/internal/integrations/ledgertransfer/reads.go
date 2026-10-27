package ledgertransfer

import (
	"context"

	cv1 "github.com/voxel-vault/api/internal/currency/contracts/v1"
	lv1 "github.com/voxel-vault/api/internal/ledger/contracts/v1"
)

// HistoryReader composes currency eligibility with Ledger's own identity/owner
// authorization. Revoked access must not conceal owned holdings or prior history.
type HistoryReader struct {
	Ledger   lv1.ReadClient
	Currency cv1.Provider
}

func (r HistoryReader) Balances(ctx context.Context, subject string) ([]lv1.AssetBalance, error) {
	return r.Ledger.Balances(ctx, subject)
}
func (r HistoryReader) History(ctx context.Context, subject, asset, cursor string, limit int) (lv1.History, error) {
	h, err := r.Ledger.History(ctx, subject, asset, cursor, limit)
	if err != nil {
		return lv1.History{}, err
	}
	access, err := r.Currency.Decide(ctx, subject, asset)
	if err != nil {
		return lv1.History{}, err
	}
	if access.CanRead || len(h.Entries) > 0 {
		return h, nil
	}
	if cursor != "" {
		first, err := r.Ledger.History(ctx, subject, asset, "", 1)
		if err != nil {
			return lv1.History{}, err
		}
		if len(first.Entries) > 0 {
			return h, nil
		}
	}
	balances, err := r.Ledger.Balances(ctx, subject)
	if err != nil {
		return lv1.History{}, err
	}
	for _, b := range balances {
		if b.Asset == asset && (b.Posted != "0" || b.Held != "0") {
			return h, nil
		}
	}
	return lv1.History{}, &lv1.Error{Code: lv1.Forbidden}
}
