package local

import (
	"context"
	"strconv"
	"time"

	"github.com/voxel-vault/api/internal/ledger/application"
	v1 "github.com/voxel-vault/api/internal/ledger/contracts/v1"
)

type Reader struct {
	Service application.Reader
	Assets  []string
}

func (r Reader) Balances(ctx context.Context, subject string) ([]v1.AssetBalance, error) {
	funds, err := r.Service.Balances(ctx, subject, r.Assets)
	if err != nil {
		return nil, publicError(err)
	}
	result := []v1.AssetBalance{}
	for _, a := range r.Assets {
		f := funds[a]
		available, err := f.Available()
		if err != nil {
			return nil, publicError(err)
		}
		result = append(result, v1.AssetBalance{Asset: a, Posted: strconv.FormatInt(f.Posted, 10), Held: strconv.FormatInt(f.Held, 10), Available: strconv.FormatInt(available, 10)})
	}
	return result, nil
}
func (r Reader) History(ctx context.Context, subject, asset, cursor string, limit int) (v1.History, error) {
	h, err := r.Service.History(ctx, subject, asset, cursor, limit)
	if err != nil {
		return v1.History{}, publicError(err)
	}
	result := v1.History{Entries: []v1.HistoryEntry{}, Next: h.Next}
	for _, e := range h.Entries {
		at := ""
		if !e.TimeUnknown {
			at = e.At.Format(time.RFC3339Nano)
		}
		result.Entries = append(result.Entries, v1.HistoryEntry{ID: e.ID, Asset: e.Asset, Direction: e.Side, Units: strconv.FormatInt(e.Units, 10), Purpose: e.Purpose, Reference: e.Reference, Status: e.Status, At: at})
	}
	return result, nil
}
