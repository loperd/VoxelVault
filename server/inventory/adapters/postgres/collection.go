package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/voxel-vault/api/inventory/application"
	"github.com/voxel-vault/api/inventory/domain"
)

func (s *Store) Collection(ctx context.Context, fn func(application.CollectionTx) error) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = fn(&unit{ctx, tx}); err != nil {
		return err
	}
	return tx.Commit()
}
func (t *unit) LockOwner(owner string) (*time.Time, error) {
	if _, err := t.tx.ExecContext(t.ctx, `INSERT INTO inventory.owners(id) VALUES($1) ON CONFLICT DO NOTHING`, owner); err != nil {
		return nil, err
	}
	var at *time.Time
	err := t.tx.QueryRowContext(t.ctx, `SELECT starter_granted_at FROM inventory.owners WHERE id=$1 FOR UPDATE`, owner).Scan(&at)
	return at, err
}
func (t *unit) MarkStarter(owner string, at time.Time) error {
	r, err := t.tx.ExecContext(t.ctx, `UPDATE inventory.owners SET starter_granted_at=$2 WHERE id=$1 AND starter_granted_at IS NULL`, owner, at)
	return one(r, err)
}
func (t *unit) ClaimCollection(id, owner, fingerprint string) (*application.CollectionResult, error) {
	if _, err := t.tx.ExecContext(t.ctx, `INSERT INTO inventory.collection_commands(id,owner,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, id, owner, fingerprint); err != nil {
		return nil, err
	}
	var raw []byte
	var oldOwner, oldFingerprint string
	if err := t.tx.QueryRowContext(t.ctx, `SELECT owner,fingerprint,result FROM inventory.collection_commands WHERE id=$1 FOR UPDATE`, id).Scan(&oldOwner, &oldFingerprint, &raw); err != nil {
		return nil, err
	}
	if oldOwner != owner || oldFingerprint != fingerprint {
		return nil, domain.ErrConflict
	}
	if raw == nil {
		return nil, nil
	}
	var r application.CollectionResult
	err := json.Unmarshal(raw, &r)
	return &r, err
}
func (t *unit) CompleteCollection(id string, result application.CollectionResult) error {
	previous, err := t.snapshot("collection_command", id)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return err
	}
	r, err := t.tx.ExecContext(t.ctx, `UPDATE inventory.collection_commands SET result=$2 WHERE id=$1 AND result IS NULL`, id, raw)
	if err = one(r, err); err != nil {
		return err
	}
	if err = t.recordLifecycle("collection_command", id, previous); err != nil {
		return err
	}
	cause, ok := application.LifecycleFromContext(t.ctx)
	if ok && cause.Kind == "merge-items" && result.Item != nil {
		var pair application.PairRequest
		if err = json.Unmarshal(cause.Payload, &pair); err != nil {
			return err
		}
		for _, parent := range []string{pair.A, pair.B} {
			if err = t.linkLifecycle("item", parent, "item", result.Item.ID, "merged_into"); err != nil {
				return err
			}
		}
	}
	return nil
}
func (t *unit) Chest(owner, id string) (domain.StoredChest, error) {
	var raw []byte
	err := t.tx.QueryRowContext(t.ctx, `SELECT body FROM inventory.chests WHERE id=$1 AND owner=$2 FOR UPDATE`, id, owner).Scan(&raw)
	if err == sql.ErrNoRows {
		return domain.StoredChest{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.StoredChest{}, err
	}
	var c domain.StoredChest
	err = json.Unmarshal(raw, &c)
	if err == nil && (c.State.ID != id || c.State.Owner != owner) {
		err = domain.ErrConflict
	}
	return c, err
}
func (t *unit) Chests(owner string) ([]domain.StoredChest, error) {
	rows, err := t.tx.QueryContext(t.ctx, `SELECT body FROM inventory.chests WHERE owner=$1 ORDER BY created_at,id FOR UPDATE`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []domain.StoredChest{}
	for rows.Next() {
		var raw []byte
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		var c domain.StoredChest
		if err = json.Unmarshal(raw, &c); err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}
func (t *unit) SaveChest(c domain.StoredChest) error {
	if err := domain.ValidateChest(c); err != nil {
		return err
	}
	previous, err := t.snapshot("chest", c.State.ID)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	r, err := t.tx.ExecContext(t.ctx, `INSERT INTO inventory.chests(id,owner,created_at,body) VALUES($1,$2,$3,$4)
 ON CONFLICT(id) DO UPDATE SET body=EXCLUDED.body WHERE inventory.chests.owner=EXCLUDED.owner`, c.State.ID, c.State.Owner, c.CreatedAt, raw)
	if err = one(r, err); err != nil {
		return err
	}
	if err = t.recordLifecycle("chest", c.State.ID, previous); err != nil {
		return err
	}
	if c.Reward != nil {
		if err = t.linkLifecycle("chest", c.State.ID, "item", c.Reward.ID, "opened_into"); err != nil {
			return err
		}
	}
	for _, parent := range c.State.Origin.Parents {
		if err = t.linkLifecycle("chest", parent, "chest", c.State.ID, "merged_into"); err != nil {
			return err
		}
	}
	return nil
}
func (t *unit) ReceiveItem(item domain.Item) error {
	if err := domain.ValidateOpeningItem(item); err != nil {
		return err
	}
	_, err := t.tx.ExecContext(t.ctx, `INSERT INTO inventory.items(id,owner,definition,condition,origin,status) VALUES($1,$2,$3,$4,$5,$6)`, item.ID, item.Owner, item.Definition, item.Condition, item.Origin, item.Status)
	if err != nil {
		return err
	}
	return t.recordLifecycle("item", item.ID, nil)
}
func (t *unit) SaveCollectionItem(item domain.Item) error {
	if err := domain.ValidateItem(item); err != nil {
		return err
	}
	if item.OperationID != "" || (item.Status != domain.Available && item.Status != domain.Retired) {
		return domain.ErrInvalid
	}
	previous, err := t.snapshot("item", item.ID)
	if err != nil {
		return err
	}
	r, err := t.tx.ExecContext(t.ctx, `UPDATE inventory.items SET condition=$3,status=$4 WHERE id=$1 AND owner=$2 AND status='available' AND operation_id IS NULL`, item.ID, item.Owner, item.Condition, item.Status)
	if err = one(r, err); err != nil {
		return err
	}
	return t.recordLifecycle("item", item.ID, previous)
}
func (s *Store) Items(ctx context.Context, owner string) ([]domain.Item, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,owner,definition,condition,origin,status,operation_id FROM inventory.items WHERE owner=$1 AND status IN ('available','locked') ORDER BY id`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []domain.Item{}
	for rows.Next() {
		var item domain.Item
		var op sql.NullString
		if err = rows.Scan(&item.ID, &item.Owner, &item.Definition, &item.Condition, &item.Origin, &item.Status, &op); err != nil {
			return nil, err
		}
		item.OperationID = op.String
		items = append(items, item)
	}
	return items, rows.Err()
}
