package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"github.com/voxel-vault/api/inventory/application"
	"github.com/voxel-vault/api/inventory/domain"
)

type Store struct{ db *sql.DB }

func New(db *sql.DB) *Store { return &Store{db} }
func (s *Store) Transact(ctx context.Context, fn func(application.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(&unit{ctx, tx}); err != nil {
		return err
	}
	return tx.Commit()
}

type unit struct {
	ctx context.Context
	tx  *sql.Tx
}

func (t *unit) ClaimOperation(id, owner, fingerprint string) (*domain.Operation, error) {
	if _, err := t.tx.ExecContext(t.ctx, `INSERT INTO inventory.operations(id,owner,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, id, owner, fingerprint); err != nil {
		return nil, err
	}
	var raw []byte
	var oldOwner, oldFingerprint string
	if err := t.tx.QueryRowContext(t.ctx, `SELECT owner,fingerprint,body FROM inventory.operations WHERE id=$1 FOR UPDATE`, id).Scan(&oldOwner, &oldFingerprint, &raw); err != nil {
		return nil, err
	}
	if oldOwner != owner || oldFingerprint != fingerprint {
		return nil, domain.ErrConflict
	}
	if raw == nil {
		return nil, nil
	}
	var op domain.Operation
	if err := json.Unmarshal(raw, &op); err != nil {
		return nil, err
	}
	return &op, nil
}
func (t *unit) LockOperation(id, owner string) (domain.Operation, error) {
	var raw []byte
	err := t.tx.QueryRowContext(t.ctx, `SELECT body FROM inventory.operations WHERE id=$1 AND ($2='' OR owner=$2) FOR UPDATE`, id, owner).Scan(&raw)
	if err == sql.ErrNoRows {
		return domain.Operation{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Operation{}, err
	}
	var op domain.Operation
	err = json.Unmarshal(raw, &op)
	return op, err
}
func (t *unit) LockItem(id, owner string) (domain.Item, error) {
	var item domain.Item
	var operation sql.NullString
	err := t.tx.QueryRowContext(t.ctx, `SELECT id,owner,definition,condition,origin,status,operation_id FROM inventory.items WHERE id=$1 AND owner=$2 FOR UPDATE`, id, owner).Scan(&item.ID, &item.Owner, &item.Definition, &item.Condition, &item.Origin, &item.Status, &operation)
	if err == sql.ErrNoRows {
		return item, domain.ErrNotFound
	}
	item.OperationID = operation.String
	return item, err
}
func (t *unit) Save(op domain.Operation, item domain.Item) error {
	if err := domain.ValidateItem(item); err != nil {
		return err
	}
	if op.ItemID != item.ID || op.Owner != item.Owner {
		return domain.ErrConflict
	}
	previousOperation, err := t.snapshot("operation", op.ID)
	if err != nil {
		return err
	}
	previousItem, err := t.snapshot("item", item.ID)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(op)
	if err != nil {
		return err
	}
	result, err := t.tx.ExecContext(t.ctx, `UPDATE inventory.operations SET body=$3 WHERE id=$1 AND owner=$2`, op.ID, op.Owner, raw)
	if err = one(result, err); err != nil {
		return err
	}
	var operation any
	if item.OperationID != "" {
		operation = item.OperationID
	}
	result, err = t.tx.ExecContext(t.ctx, `UPDATE inventory.items SET condition=$3,status=$4,operation_id=$5 WHERE id=$1 AND owner=$2`, item.ID, item.Owner, item.Condition, item.Status, operation)
	if err = one(result, err); err != nil {
		return err
	}
	if err = t.recordLifecycle("operation", op.ID, previousOperation); err != nil {
		return err
	}
	return t.recordLifecycle("item", item.ID, previousItem)
}
func (t *unit) Enqueue(c domain.SettlementCommand) error {
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	r, err := t.tx.ExecContext(t.ctx, `INSERT INTO inventory.outbox(id,payload) VALUES($1,$2)
 ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload WHERE inventory.outbox.payload=EXCLUDED.payload`, c.ID, raw)
	return one(r, err)
}
func (t *unit) Inbox(id, fingerprint string) (bool, error) {
	r, err := t.tx.ExecContext(t.ctx, `INSERT INTO inventory.inbox(id,fingerprint) VALUES($1,$2) ON CONFLICT DO NOTHING`, id, fingerprint)
	if err != nil {
		return false, err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return false, err
	}
	var existing string
	if err := t.tx.QueryRowContext(t.ctx, `SELECT fingerprint FROM inventory.inbox WHERE id=$1 FOR UPDATE`, id).Scan(&existing); err != nil {
		return false, err
	}
	if existing != fingerprint {
		return false, domain.ErrConflict
	}
	return n == 0, nil
}
func (s *Store) Operation(ctx context.Context, owner, id string) (domain.Operation, error) {
	var raw []byte
	err := s.db.QueryRowContext(ctx, `SELECT body FROM inventory.operations WHERE id=$1 AND owner=$2`, id, owner).Scan(&raw)
	if err == sql.ErrNoRows {
		return domain.Operation{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Operation{}, err
	}
	var op domain.Operation
	err = json.Unmarshal(raw, &op)
	return op, err
}
func one(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return domain.ErrConflict
	}
	return nil
}
