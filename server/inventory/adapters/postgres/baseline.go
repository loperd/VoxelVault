package postgres

import (
	"context"
	"database/sql"
	v1 "github.com/voxel-vault/api/inventory/contracts/v1"
)

func (s *Store) Baseline(ctx context.Context) (v1.Baseline, error) {
	var b v1.Baseline
	err := s.db.QueryRowContext(ctx, `SELECT i.source,i.digest FROM inventory.opening_baseline i
 JOIN inventory.chest_baseline c ON c.source=i.source AND c.digest=i.digest WHERE i.singleton AND c.singleton`).Scan(&b.Source, &b.Digest)
	if err == sql.ErrNoRows {
		return b, nil
	}
	b.Complete = err == nil
	return b, err
}
