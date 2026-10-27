package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"github.com/voxel-vault/api/inventory/application"
	"time"
)

func (s *Store) ClaimJobs(ctx context.Context, owner string, now time.Time, ttl time.Duration, limit int) ([]application.Job, error) {
	rows, err := s.db.QueryContext(ctx, `WITH ready AS (
 SELECT id FROM inventory.outbox WHERE finished_at IS NULL AND available_at<=$1
 AND (lease_until IS NULL OR lease_until<=$1) ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT $2
 ) UPDATE inventory.outbox o SET lease_owner=$3,lease_until=$4,lease_fence=o.lease_fence+1,attempts=o.attempts+1
 FROM ready WHERE o.id=ready.id RETURNING o.payload,o.lease_fence,o.attempts`, now, limit, owner, now.Add(ttl))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []application.Job
	for rows.Next() {
		var raw []byte
		var j application.Job
		if err := rows.Scan(&raw, &j.Fence, &j.Attempts); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &j.Command); err != nil {
			return nil, err
		}
		result = append(result, j)
	}
	return result, rows.Err()
}
func (s *Store) FinishJob(ctx context.Context, id, owner string, fence int64, now time.Time, code string) error {
	r, err := s.db.ExecContext(ctx, `UPDATE inventory.outbox SET finished_at=$4,terminal_error=NULLIF($5,''),lease_owner=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND lease_fence=$3 AND lease_until>$4 AND finished_at IS NULL`, id, owner, fence, now, code)
	return lease(r, err)
}
func (s *Store) RetryJob(ctx context.Context, id, owner string, fence int64, now, next time.Time) error {
	r, err := s.db.ExecContext(ctx, `UPDATE inventory.outbox SET available_at=$5,lease_owner=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND lease_fence=$3 AND lease_until>$4 AND finished_at IS NULL`, id, owner, fence, now, next)
	return lease(r, err)
}
func lease(r sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return application.ErrLeaseLost
	}
	return nil
}
