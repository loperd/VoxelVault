package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/voxel-vault/api/internal/ledger/application"
	"github.com/voxel-vault/api/internal/ledger/domain"
	"github.com/voxel-vault/api/internal/platform/outbox"
	"time"
)

// journalKind marks receipt events; the typed queues below never see other kinds
// (restriction events share the table but have a different payload).
const journalKind = "ledger.journal.posted"

func (s *Store) ClaimEvents(ctx context.Context, owner string, now time.Time, ttl time.Duration, limit int) ([]application.Delivery, error) {
	return s.claimEvents(ctx, "", owner, now, ttl, limit)
}
func (s *Store) table() outbox.Table { return outbox.Table{DB: s.db, Name: "ledger.outbox"} }

func (s *Store) claimEvents(ctx context.Context, producer, owner string, now time.Time, ttl time.Duration, limit int) ([]application.Delivery, error) {
	q, err := s.table().Topic(producer, journalKind)
	if err != nil {
		return nil, err
	}
	batch, err := q.Claim(ctx, owner, now, ttl, limit)
	if err != nil {
		return nil, err
	}
	result := make([]application.Delivery, 0, len(batch))
	for _, b := range batch {
		d := application.Delivery{Fence: b.Fence, Attempts: b.Attempts}
		if err := json.Unmarshal(b.Body, &d.Event); err != nil {
			return nil, err
		}
		result = append(result, d)
	}
	return result, nil
}
func (s *Store) AckEvent(ctx context.Context, id, owner string, fence int64, now time.Time) error {
	q, err := s.table().Topic("", journalKind)
	if err != nil {
		return err
	}
	return leaseResult(q.Ack(ctx, id, owner, fence, now))
}
func (s *Store) RetryEvent(ctx context.Context, id, owner string, fence int64, now, next time.Time) error {
	q, err := s.table().Topic("", journalKind)
	if err != nil {
		return err
	}
	return leaseResult(q.Retry(ctx, id, owner, fence, now, next))
}

func leaseResult(err error) error {
	if errors.Is(err, outbox.ErrLeaseLost) {
		return application.ErrLeaseLost
	}
	return err
}

// EventsFor isolates coordinator reply queues. An Inventory worker cannot consume and
// acknowledge a future Shop producer's events, even while sharing the Wallet database.
func (s *Store) EventsFor(producer string) (application.Outbox, error) {
	if !domain.ValidID(producer) {
		return nil, domain.ErrInvalid
	}
	return producerQueue{s, producer}, nil
}

type producerQueue struct {
	*Store
	producer string
}

func (q producerQueue) ClaimEvents(ctx context.Context, owner string, now time.Time, ttl time.Duration, limit int) ([]application.Delivery, error) {
	return q.Store.claimEvents(ctx, q.producer, owner, now, ttl, limit)
}
