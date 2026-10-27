package postgres

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"reflect"

	"github.com/voxel-vault/api/inventory/application"
	"github.com/voxel-vault/api/inventory/domain"
)

type lifecycleRow struct {
	ID, Owner, Definition, Condition, Origin, Status string
	OperationID                                      string `json:"operation_id"`
	Body                                             json.RawMessage
	Result                                           json.RawMessage
}

func sameJSON(a, b []byte) bool {
	if bytes.Equal(a, b) {
		return true
	}
	decode := func(raw []byte) any {
		d := json.NewDecoder(bytes.NewReader(raw))
		d.UseNumber()
		var v any
		if d.Decode(&v) != nil {
			return nil
		}
		return v
	}
	return reflect.DeepEqual(decode(a), decode(b))
}

func lifecycleTable(kind string) string {
	switch kind {
	case "item":
		return "inventory.items"
	case "chest":
		return "inventory.chests"
	case "operation":
		return "inventory.operations"
	case "collection_command":
		return "inventory.collection_commands"
	}
	return ""
}

func (t *unit) snapshot(kind, id string) ([]byte, error) {
	table := lifecycleTable(kind)
	if table == "" {
		return nil, domain.ErrInvalid
	}
	var raw []byte
	err := t.tx.QueryRowContext(t.ctx, `SELECT to_jsonb(r) FROM `+table+` r WHERE id=$1 FOR UPDATE`, id).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return raw, err
}

func (t *unit) custody(kind string, r lifecycleRow) (domain.Custody, error) {
	switch kind {
	case "item":
		var op *domain.Operation
		if r.OperationID != "" {
			var raw []byte
			if err := t.tx.QueryRowContext(t.ctx, `SELECT body FROM inventory.operations WHERE id=$1`, r.OperationID).Scan(&raw); err != nil {
				return domain.Custody{}, err
			}
			if err := json.Unmarshal(raw, &op); err != nil {
				return domain.Custody{}, err
			}
		}
		return domain.ItemCustody(domain.Item{ID: r.ID, Owner: r.Owner, Status: r.Status, OperationID: r.OperationID}, op), nil
	case "chest":
		var c domain.StoredChest
		if err := json.Unmarshal(r.Body, &c); err != nil {
			return domain.Custody{}, err
		}
		switch string(c.State.Status) {
		case "available":
			return domain.Custody{Location: "player", Custodian: r.Owner}, nil
		case "opening":
			return domain.Custody{Location: "escrow", Custodian: r.Owner, Session: c.State.Session}, nil
		default:
			return domain.Custody{Location: "archive", Disposition: string(c.State.Status)}, nil
		}
	}
	return domain.Custody{Location: "operation", Custodian: r.Owner}, nil
}

// recordLifecycle validates and appends history explicitly in Go, inside the
// source write's local transaction. It exposes no update/delete history API.
func (t *unit) recordLifecycle(kind, id string, previous []byte) error {
	after, err := t.snapshot(kind, id)
	if err != nil {
		return err
	}
	if after == nil {
		return domain.ErrNotFound
	}
	var row, old lifecycleRow
	if err = json.Unmarshal(after, &row); err != nil {
		return err
	}
	if len(previous) > 0 {
		if err = json.Unmarshal(previous, &old); err != nil {
			return err
		}
		if old.ID != row.ID || old.Owner != row.Owner || kind == "item" && (old.Definition != row.Definition || old.Origin != row.Origin) {
			return domain.ErrConflict
		}
	}
	var version int64
	var head, headCustody []byte
	err = t.tx.QueryRowContext(t.ctx, `SELECT version,snapshot,custody FROM inventory.instance_registry WHERE kind=$1 AND id=$2 FOR UPDATE`, kind, id).Scan(&version, &head, &headCustody)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == sql.ErrNoRows {
		placeholder := kind == "operation" && (len(old.Body) == 0 || string(old.Body) == "null") || kind == "collection_command" && (len(old.Result) == 0 || string(old.Result) == "null")
		if len(previous) > 0 && !placeholder {
			return domain.ErrConflict
		}
	} else if !sameJSON(head, previous) {
		return domain.ErrConflict
	}
	position, err := t.custody(kind, row)
	if err != nil {
		return err
	}
	var oldPosition domain.Custody
	if headCustody != nil {
		if err = json.Unmarshal(headCustody, &oldPosition); err != nil {
			return err
		}
	}
	changed := !sameJSON(head, after)
	if err = domain.CheckCustodyTransition(oldPosition, position, changed); err != nil {
		return err
	}
	if !changed && oldPosition == position {
		return nil
	}
	var recordedBy string
	if err = t.tx.QueryRowContext(t.ctx, `SELECT current_user`).Scan(&recordedBy); err != nil {
		return err
	}
	cause, ok := application.LifecycleFromContext(t.ctx)
	if !ok {
		var maintenance bool
		if err = t.tx.QueryRowContext(t.ctx, `SELECT pg_has_role(current_user,(SELECT nspowner FROM pg_namespace WHERE nspname='inventory'),'USAGE')`).Scan(&maintenance); err != nil {
			return err
		}
		if !maintenance {
			return domain.ErrInvalid
		}
		cause = application.LifecycleCause{Kind: "maintenance_checkpoint", ID: "checkpoint", Payload: json.RawMessage(`{"historyBeforeCheckpoint":"unknown"}`)}
	}
	evidence, err := json.Marshal(cause)
	if err != nil {
		return err
	}
	custody, err := json.Marshal(position)
	if err != nil {
		return err
	}
	if _, err = t.tx.ExecContext(t.ctx, `INSERT INTO inventory.lifecycle_entries(kind,id,version,before_snapshot,after_snapshot,before_custody,after_custody,cause,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, kind, id, version+1, jsonOrNull(head), after, jsonOrNull(headCustody), custody, evidence, recordedBy); err != nil {
		return err
	}
	_, err = t.tx.ExecContext(t.ctx, `INSERT INTO inventory.instance_registry(kind,id,version,snapshot,custody) VALUES($1,$2,$3,$4,$5) ON CONFLICT(kind,id) DO UPDATE SET version=EXCLUDED.version,snapshot=EXCLUDED.snapshot,custody=EXCLUDED.custody`, kind, id, version+1, after, custody)
	return err
}

func jsonOrNull(raw []byte) any {
	if raw == nil {
		return nil
	}
	return raw
}

func (t *unit) linkLifecycle(fromKind, fromID, toKind, toID, relation string) error {
	if fromID == toID && fromKind == toKind {
		return nil
	}
	cause, ok := application.LifecycleFromContext(t.ctx)
	if !ok {
		return nil
	}
	_, err := t.tx.ExecContext(t.ctx, `INSERT INTO inventory.lifecycle_links(cause_id,relation,from_kind,from_id,from_version,to_kind,to_id,to_version)
 SELECT $1,$2,a.kind,a.id,a.version,b.kind,b.id,b.version FROM inventory.instance_registry a,inventory.instance_registry b
 WHERE a.kind=$3 AND a.id=$4 AND b.kind=$5 AND b.id=$6 ON CONFLICT DO NOTHING`, cause.ID, relation, fromKind, fromID, toKind, toID)
	return err
}

// BootstrapLifecycle is called by the explicit Inventory migration under its
// local write locks. Existing facts become checkpoints, not invented history.
func BootstrapLifecycle(ctx context.Context, tx *sql.Tx) error {
	u := unit{ctx, tx}
	for _, kind := range []string{"operation", "item", "chest", "collection_command"} {
		filter := ""
		if kind == "operation" {
			filter = " WHERE body IS NOT NULL"
		}
		if kind == "collection_command" {
			filter = " WHERE result IS NOT NULL"
		}
		if filter == "" {
			filter = " WHERE "
		} else {
			filter += " AND "
		}
		filter += `NOT EXISTS(SELECT 1 FROM inventory.instance_registry h WHERE h.kind=$1 AND h.id=r.id)`
		rows, err := tx.QueryContext(ctx, `SELECT id FROM `+lifecycleTable(kind)+` r`+filter+` ORDER BY id`, kind)
		if err != nil {
			return err
		}
		var ids []string
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, id := range ids {
			if err = u.recordLifecycle(kind, id, nil); err != nil {
				return err
			}
		}
	}
	return nil
}
