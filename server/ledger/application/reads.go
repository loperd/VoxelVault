package application

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"time"

	"github.com/voxel-vault/api/ledger/domain"
)

type HistoryCursor struct {
	Subject, Asset, ID string
	At                 time.Time
}
type HistoryEntry struct {
	ID, Asset, Side, Purpose, Reference, Status string
	Units                                       int64
	At                                          time.Time
	TimeUnknown                                 bool
}
type History struct {
	Entries []HistoryEntry
	Next    string
}
type ReadStore interface {
	Balances(context.Context, string, []string) (map[string]domain.Funds, error)
	History(context.Context, string, string, *HistoryCursor, int) ([]HistoryEntry, error)
}
type Reader struct {
	Store      ReadStore
	Authorizer Authorizer
	Producer   string
}

func (r Reader) scope(ctx context.Context, subject, asset string) error {
	if r.Store == nil || r.Authorizer == nil || !domain.ValidID(r.Producer) || !domain.ValidID(subject) || !domain.ValidID(asset) {
		return domain.ErrInvalid
	}
	return r.Authorizer.Authorize(ctx, r.Producer, ReadCapability, &domain.Terms{Subject: subject, Asset: asset})
}
func (r Reader) Balances(ctx context.Context, subject string, assets []string) (map[string]domain.Funds, error) {
	if len(assets) == 0 || len(assets) > 100 {
		return nil, domain.ErrInvalid
	}
	assets = append([]string(nil), assets...)
	for _, a := range assets {
		if err := r.scope(ctx, subject, a); err != nil {
			return nil, err
		}
	}
	return r.Store.Balances(ctx, subject, assets)
}
func (r Reader) History(ctx context.Context, subject, asset, cursor string, limit int) (History, error) {
	var result History
	if err := r.scope(ctx, subject, asset); err != nil {
		return result, err
	}
	if limit < 1 || limit > 100 || len(cursor) > 2048 {
		return result, domain.ErrInvalid
	}
	var after *HistoryCursor
	if cursor != "" {
		b, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil {
			return result, domain.ErrInvalid
		}
		var c HistoryCursor
		if json.Unmarshal(b, &c) != nil || c.Subject != subject || c.Asset != asset || !domain.ValidID(c.ID) || c.At.IsZero() {
			return result, domain.ErrInvalid
		}
		after = &c
	}
	entries, err := r.Store.History(ctx, subject, asset, after, limit+1)
	if err != nil {
		return result, err
	}
	if len(entries) > limit {
		entries = entries[:limit]
		last := entries[len(entries)-1]
		b, _ := json.Marshal(HistoryCursor{Subject: subject, Asset: asset, ID: last.ID, At: last.At})
		result.Next = base64.RawURLEncoding.EncodeToString(b)
	}
	result.Entries = entries
	return result, nil
}
