package postgres

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/voxel-vault/api/inventory/application"
	"github.com/voxel-vault/api/inventory/domain"
)

func (s *Store) ImportChests(ctx context.Context, input application.ChestsOpening) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, collectionBaselineLock); err != nil {
		return err
	}
	var itemPayload []byte
	if err = tx.QueryRowContext(ctx, `SELECT payload FROM inventory.opening_baseline WHERE singleton AND source=$1 AND digest=$2`, input.Source, input.Digest).Scan(&itemPayload); err == sql.ErrNoRows {
		return domain.ErrConflict
	} else if err != nil {
		return err
	}
	var items application.Opening
	if err = json.Unmarshal(itemPayload, &items); err != nil {
		return err
	}
	// The item baseline must still be unchanged before attaching chest reward receipts.
	for _, table := range []string{"operations", "inbox", "outbox", "collection_commands"} {
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
	if n != len(items.Items) {
		return domain.ErrConflict
	}
	u := &unit{ctx, tx}
	for _, item := range items.Items {
		actual, err := u.LockItem(item.ID, item.Owner)
		if err != nil {
			return err
		}
		if actual != item {
			return domain.ErrConflict
		}
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return err
	}
	var same bool
	err = tx.QueryRowContext(ctx, `SELECT source=$1 AND digest=$2 AND payload=$3::jsonb FROM inventory.chest_baseline`, input.Source, input.Digest, raw).Scan(&same)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == sql.ErrNoRows {
		for _, table := range []string{"owners", "chests"} {
			var exists bool
			if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM inventory.`+table+`)`).Scan(&exists); err != nil {
				return err
			}
			if exists {
				return domain.ErrConflict
			}
		}
		for _, o := range input.Owners {
			if _, err = tx.ExecContext(ctx, `INSERT INTO inventory.owners(id,starter_granted_at) VALUES($1,$2)`, o.ID, o.StarterGrantedAt); err != nil {
				return err
			}
		}
		for _, c := range input.Chests {
			var originCount int
			if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM inventory.items WHERE origin=$1`, c.State.ID).Scan(&originCount); err != nil {
				return err
			}
			expected := 0
			if c.Reward != nil {
				expected = 1
			}
			if originCount != expected {
				return domain.ErrConflict
			}
			if c.Reward != nil {
				item, err := u.LockItem(c.Reward.ID, c.State.Owner)
				if err != nil {
					return err
				}
				if item.Origin != c.State.ID || item.Definition != c.Reward.Definition {
					return domain.ErrConflict
				}
			}
			if err = u.SaveChest(c); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO inventory.chest_baseline(singleton,source,digest,payload) VALUES(true,$1,$2,$3)`, input.Source, input.Digest, raw); err != nil {
			return err
		}
	} else if !same {
		return domain.ErrConflict
	}
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM inventory.owners`).Scan(&n); err != nil {
		return err
	}
	if n != len(input.Owners) {
		return domain.ErrConflict
	}
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM inventory.chests`).Scan(&n); err != nil {
		return err
	}
	if n != len(input.Chests) {
		return domain.ErrConflict
	}
	for _, o := range input.Owners {
		var equal bool
		if err = tx.QueryRowContext(ctx, `SELECT starter_granted_at IS NOT DISTINCT FROM $2::timestamptz FROM inventory.owners WHERE id=$1`, o.ID, o.StarterGrantedAt).Scan(&equal); err != nil {
			return err
		}
		if !equal {
			return domain.ErrConflict
		}
	}
	for _, c := range input.Chests {
		expected, err := json.Marshal(c)
		if err != nil {
			return err
		}
		var equal bool
		if err = tx.QueryRowContext(ctx, `SELECT owner=$2 AND body=$3::jsonb FROM inventory.chests WHERE id=$1`, c.State.ID, c.State.Owner, expected).Scan(&equal); err != nil {
			return err
		}
		if !equal {
			return domain.ErrConflict
		}
	}
	return tx.Commit()
}

const collectionBaselineLock = `LOCK TABLE inventory.operations,inventory.items,inventory.inbox,inventory.outbox,inventory.opening_baseline,inventory.owners,inventory.chests,inventory.collection_commands,inventory.chest_baseline IN EXCLUSIVE MODE`
