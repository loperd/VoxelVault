// Package legacy reads the old storage shape only for an explicit offline export.
package legacy

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/voxel-vault/api/internal/economycutover"
	iv1 "github.com/voxel-vault/api/internal/inventory/contracts/v1"
	wv1 "github.com/voxel-vault/api/internal/ledger/contracts/v1"
)

type Source struct {
	DB *sql.DB
	// Preflight must be pure and local: no database, network or other I/O calls while
	// the source snapshot transaction holds its locks.
	Preflight func(economycutover.Snapshot) error
}

// FreezeAndExport waits for in-flight writers, snapshots all economy records, and commits
// the artifact with the permanent write barrier. A retry returns the identical artifact.
func (s Source) FreezeAndExport(ctx context.Context, source string) (economycutover.Snapshot, error) {
	var result economycutover.Snapshot
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	var frozen bool
	var priorSource sql.NullString
	var raw []byte
	if err = tx.QueryRowContext(ctx, `SELECT frozen,source,manifest FROM legacy_economy_cutover.snapshot WHERE singleton FOR UPDATE`).Scan(&frozen, &priorSource, &raw); err != nil {
		return result, err
	}
	if frozen {
		if priorSource.String != source {
			return result, fmt.Errorf("legacy source already frozen with another identity")
		}
		if err = json.Unmarshal(raw, &result); err != nil {
			return result, err
		}
		if err = result.Check(); err != nil {
			return result, err
		}
		return result, tx.Commit()
	}
	// Same order as Go application writers: barrier lease, then data tables.
	if _, err = tx.ExecContext(ctx, `LOCK TABLE public.economy_owners,public.chest_instances,public.inventory_items,public.wallet_balances IN EXCLUSIVE MODE`); err != nil {
		return result, err
	}
	result = economycutover.Snapshot{Version: 1, Source: source, FrozenAt: time.Now().UTC(), Owners: []economycutover.Owner{}, Items: []iv1.OpeningItem{}, Balances: []wv1.OpeningBalance{}, Chests: []economycutover.ChestArchive{}}
	rows, err := tx.QueryContext(ctx, `SELECT id,starter_granted_at FROM public.economy_owners ORDER BY id`)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var o economycutover.Owner
		if err = rows.Scan(&o.ID, &o.StarterGrantedAt); err != nil {
			rows.Close()
			return result, err
		}
		result.Owners = append(result.Owners, o)
	}
	if err = finish(rows); err != nil {
		return result, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT id,user_id,item_id,state,origin FROM public.inventory_items ORDER BY id`)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var i iv1.OpeningItem
		if err = rows.Scan(&i.ID, &i.Owner, &i.Definition, &i.Condition, &i.Origin); err != nil {
			rows.Close()
			return result, err
		}
		result.Items = append(result.Items, i)
	}
	if err = finish(rows); err != nil {
		return result, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT user_id,resource,value::text FROM public.wallet_balances ORDER BY user_id,resource`)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var b wv1.OpeningBalance
		if err = rows.Scan(&b.Subject, &b.Asset, &b.Units); err != nil {
			rows.Close()
			return result, err
		}
		result.Balances = append(result.Balances, b)
	}
	if err = finish(rows); err != nil {
		return result, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT id,user_id,to_jsonb(c) FROM public.chest_instances c ORDER BY id`)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var c economycutover.ChestArchive
		if err = rows.Scan(&c.ID, &c.Owner, &c.Record); err != nil {
			rows.Close()
			return result, err
		}
		result.Chests = append(result.Chests, c)
	}
	if err = finish(rows); err != nil {
		return result, err
	}
	if err = result.Seal(); err != nil {
		return result, err
	}
	if s.Preflight != nil {
		if err = s.Preflight(result); err != nil {
			return result, err
		}
	}
	raw, err = json.Marshal(result)
	if err != nil {
		return result, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE legacy_economy_cutover.snapshot SET frozen=true,source=$1,digest=$2,manifest=$3 WHERE singleton`, source, result.Digest, raw); err != nil {
		return result, err
	}
	return result, tx.Commit()
}
func finish(rows *sql.Rows) error {
	err := rows.Err()
	closeErr := rows.Close()
	if err != nil {
		return err
	}
	return closeErr
}
