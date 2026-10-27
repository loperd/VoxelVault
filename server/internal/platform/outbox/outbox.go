// Package outbox is the generic transactional outbox: a context writes an Envelope in the same
// transaction as its change, and a Dispatcher leases, publishes and acknowledges it later.
// A context owns its table (schema.outbox); the columns are id, producer (the topic), kind,
// payload, created_at, available_at, lease_*, attempts and delivered_at. Nothing is ever deleted.
package outbox

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"time"
)

var ErrLeaseLost = errors.New("outbox lease lost")

// Envelope is the delivery unit. ID must be stable and unique per fact: publishing it twice
// writes one row, so retries and parallel writers never duplicate an event.
type Envelope struct {
	ID, Topic, Kind string
	Body            []byte // JSON
	At              time.Time
}

type Delivery struct {
	Envelope
	Fence    int64
	Attempts int
}

type Queue interface {
	Claim(ctx context.Context, owner string, now time.Time, ttl time.Duration, limit int) ([]Delivery, error)
	Ack(ctx context.Context, id, owner string, fence int64, now time.Time) error
	Retry(ctx context.Context, id, owner string, fence int64, now, next time.Time) error
}

type Publisher interface {
	Publish(context.Context, Envelope) error
}

type Execer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

var tableName = regexp.MustCompile(`^[a-z_]+\.[a-z_]+$`)

// Table is one context's outbox table, e.g. "ledger.outbox".
type Table struct {
	DB   *sql.DB
	Name string
}

// Publish writes the envelope on tx; a repeated ID is a no-op, not an error.
func Publish(ctx context.Context, tx Execer, table string, e Envelope) error {
	if !tableName.MatchString(table) || e.ID == "" || e.Topic == "" || e.Kind == "" || len(e.Body) == 0 || e.At.IsZero() {
		return fmt.Errorf("invalid outbox envelope")
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO `+table+`(id,payload,created_at,available_at,producer,kind) VALUES($1,$2,$3,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
		e.ID, e.Body, e.At, e.Topic, e.Kind)
	return err
}

// Topic is the queue of one topic and kind; "" matches any.
func (t Table) Topic(topic, kind string) (Queue, error) {
	if t.DB == nil || !tableName.MatchString(t.Name) {
		return nil, fmt.Errorf("invalid outbox table")
	}
	return queue{t, topic, kind}, nil
}

type queue struct {
	Table
	topic, kind string
}

func (q queue) Claim(ctx context.Context, owner string, now time.Time, ttl time.Duration, limit int) ([]Delivery, error) {
	rows, err := q.DB.QueryContext(ctx, `WITH ready AS (
 SELECT id FROM `+q.Name+` WHERE delivered_at IS NULL AND available_at<=$1 AND ($5='' OR producer=$5) AND ($6='' OR kind=$6)
 AND (lease_until IS NULL OR lease_until<=$1) ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT $2
 ) UPDATE `+q.Name+` o SET lease_owner=$3,lease_until=$4,lease_fence=o.lease_fence+1,attempts=o.attempts+1
 FROM ready WHERE o.id=ready.id RETURNING o.id,o.producer,o.kind,o.payload,o.created_at,o.lease_fence,o.attempts`,
		now, limit, owner, now.Add(ttl), q.topic, q.kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Delivery
	for rows.Next() {
		var d Delivery
		if err := rows.Scan(&d.ID, &d.Topic, &d.Kind, &d.Body, &d.At, &d.Fence, &d.Attempts); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (q queue) Ack(ctx context.Context, id, owner string, fence int64, now time.Time) error {
	r, err := q.DB.ExecContext(ctx, `UPDATE `+q.Name+` SET delivered_at=$4,lease_owner=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND lease_fence=$3 AND lease_until>$4 AND delivered_at IS NULL`, id, owner, fence, now)
	return leaseResult(r, err)
}

func (q queue) Retry(ctx context.Context, id, owner string, fence int64, now, next time.Time) error {
	r, err := q.DB.ExecContext(ctx, `UPDATE `+q.Name+` SET available_at=$5,lease_owner=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND lease_fence=$3 AND lease_until>$4 AND delivered_at IS NULL`, id, owner, fence, now, next)
	return leaseResult(r, err)
}

func leaseResult(r sql.Result, err error) error {
	if err != nil {
		return err
	}
	if n, err := r.RowsAffected(); err != nil || n != 1 {
		if err == nil {
			err = ErrLeaseLost
		}
		return err
	}
	return nil
}

type Dispatcher struct {
	Queue     Queue
	Publisher Publisher
	Owner     string
	Clock     func() time.Time
	Lease     time.Duration
	Limit     int
}
type Stats struct{ Claimed, Published, Retried int }

// RunOnce releases database locks before calling the transport. A crash after publication
// leaves a retryable lease; recipients must deduplicate the stable envelope ID.
func (d Dispatcher) RunOnce(ctx context.Context) (Stats, error) {
	var stats Stats
	if d.Queue == nil || d.Publisher == nil || d.Owner == "" || d.Clock == nil || d.Lease <= 0 || d.Limit < 1 || d.Limit > 256 {
		return stats, errors.New("invalid outbox dispatcher configuration")
	}
	batch, err := d.Queue.Claim(ctx, d.Owner, d.Clock().UTC(), d.Lease, d.Limit)
	if err != nil {
		return stats, err
	}
	stats.Claimed = len(batch)
	var failures []error
	for _, x := range batch {
		if err := d.Publisher.Publish(ctx, x.Envelope); err != nil {
			now := d.Clock().UTC()
			delay := time.Second * time.Duration(1<<min(x.Attempts, 5))
			if e := d.Queue.Retry(ctx, x.ID, d.Owner, x.Fence, now, now.Add(delay)); e != nil {
				failures = append(failures, e)
			}
			failures = append(failures, err)
			stats.Retried++
			continue
		}
		if err := d.Queue.Ack(ctx, x.ID, d.Owner, x.Fence, d.Clock().UTC()); err != nil {
			failures = append(failures, err)
			continue
		}
		stats.Published++
	}
	return stats, errors.Join(failures...)
}
