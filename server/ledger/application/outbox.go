package application

import (
	"context"
	"errors"
	"time"
)

var ErrLeaseLost = errors.New("wallet outbox lease lost")

type Delivery struct {
	Event    Event
	Fence    int64
	Attempts int
}
type Outbox interface {
	ClaimEvents(context.Context, string, time.Time, time.Duration, int) ([]Delivery, error)
	AckEvent(context.Context, string, string, int64, time.Time) error
	RetryEvent(context.Context, string, string, int64, time.Time, time.Time) error
}
type Publisher interface {
	Publish(context.Context, Event) error
}
type Dispatcher struct {
	Store     Outbox
	Publisher Publisher
	Owner     string
	Clock     func() time.Time
	Lease     time.Duration
	Limit     int
}
type DeliveryStats struct{ Claimed, Published, Retried int }

// RunOnce releases database locks before calling the transport. A crash after publication
// leaves a retryable lease; recipients must deduplicate the stable event identity.
func (d Dispatcher) RunOnce(ctx context.Context) (DeliveryStats, error) {
	var stats DeliveryStats
	if d.Store == nil || d.Publisher == nil || d.Owner == "" || d.Clock == nil || d.Lease <= 0 || d.Limit < 1 || d.Limit > 256 {
		return stats, errors.New("invalid wallet dispatcher configuration")
	}
	batch, err := d.Store.ClaimEvents(ctx, d.Owner, d.Clock().UTC(), d.Lease, d.Limit)
	if err != nil {
		return stats, err
	}
	stats.Claimed = len(batch)
	var failures []error
	for _, delivery := range batch {
		if err := d.Publisher.Publish(ctx, delivery.Event); err != nil {
			now := d.Clock().UTC()
			delay := time.Second * time.Duration(1<<min(delivery.Attempts, 5))
			if retryErr := d.Store.RetryEvent(ctx, delivery.Event.ID, d.Owner, delivery.Fence, now, now.Add(delay)); retryErr != nil {
				failures = append(failures, retryErr)
			}
			failures = append(failures, err)
			stats.Retried++
			continue
		}
		if err := d.Store.AckEvent(ctx, delivery.Event.ID, d.Owner, delivery.Fence, d.Clock().UTC()); err != nil {
			failures = append(failures, err)
			continue
		}
		stats.Published++
	}
	return stats, errors.Join(failures...)
}
