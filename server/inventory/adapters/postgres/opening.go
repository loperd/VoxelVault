package postgres

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/voxel-vault/api/inventory/application"
	"github.com/voxel-vault/api/inventory/domain"
)

func (s *Store) ImportItems(ctx context.Context, input application.Opening) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, collectionBaselineLock); err != nil {
		return err
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return err
	}
	var same bool
	err = tx.QueryRowContext(ctx, `SELECT source=$1 AND digest=$2 AND payload=$3::jsonb FROM inventory.opening_baseline`, input.Source, input.Digest, raw).Scan(&same)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == sql.ErrNoRows {
		for _, table := range []string{"operations", "items", "inbox", "outbox", "owners", "chests", "collection_commands", "chest_baseline"} {
			var exists bool
			if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM inventory.`+table+`)`).Scan(&exists); err != nil {
				return err
			}
			if exists {
				return domain.ErrConflict
			}
		}
		for _, item := range input.Items {
			if _, err = tx.ExecContext(ctx, `INSERT INTO inventory.items(id,owner,definition,condition,origin,status) VALUES($1,$2,$3,$4,$5,'available')`, item.ID, item.Owner, item.Definition, item.Condition, item.Origin); err != nil {
				return err
			}
			if err = (&unit{ctx, tx}).recordLifecycle("item", item.ID, nil); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO inventory.opening_baseline(singleton,source,digest,payload) VALUES(true,$1,$2,$3)`, input.Source, input.Digest, raw); err != nil {
			return err
		}
	} else if !same {
		return domain.ErrConflict
	}
	for _, table := range []string{"operations", "inbox", "outbox"} {
		var exists bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM inventory.`+table+`)`).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return domain.ErrConflict
		}
	}
	var n int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM inventory.items`).Scan(&n); err != nil {
		return err
	}
	if n != len(input.Items) {
		return domain.ErrConflict
	}
	t := &unit{ctx, tx}
	for _, item := range input.Items {
		actual, err := t.LockItem(item.ID, item.Owner)
		if err != nil {
			return err
		}
		if actual != item {
			return domain.ErrConflict
		}
	}
	return tx.Commit()
}
