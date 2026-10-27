package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/voxel-vault/api/internal/ledger/domain"
	"github.com/voxel-vault/api/internal/platform/outbox"
)

// RestrictionTopic carries restriction.added|lifted|expired. The body holds ids and times only
// (never the internal reason): {"id","account","kind","expiresAt","actor"}. Event ids are
// restriction:<id>:<added|lifted|expired>, so each fact is published once.
const RestrictionTopic = "account-restrictions"

func publishRestriction(ctx context.Context, tx *sql.Tx, event string, id int64, account, kind string, expires *time.Time, actor string, at time.Time) error {
	body, err := json.Marshal(map[string]any{"id": id, "account": account, "kind": kind, "expiresAt": expires, "actor": actor})
	if err != nil {
		return err
	}
	return outbox.Publish(ctx, tx, "ledger.outbox", outbox.Envelope{
		ID: fmt.Sprintf("restriction:%d:%s", id, event), Topic: RestrictionTopic, Kind: "restriction." + event, Body: body, At: at})
}

// Restriction is one row of ledger.account_restrictions. Rows are never deleted;
// lifting only sets LiftedAt/LiftedBy, which the runtime role cannot do.
type Restriction struct {
	ID                  int64
	Account, Kind       string
	Reason, Actor       string
	CreatedAt           time.Time
	ExpiresAt, LiftedAt *time.Time
	LiftedBy            string
}

// Restrict and Lift are operator operations: they need an operator connection.
func (s *Store) Restrict(ctx context.Context, account, kind, reason, actor string, expires *time.Time) (int64, error) {
	if !domain.ValidID(account) || (kind != "send" && kind != "receive") || reason == "" || !domain.ValidID(actor) {
		return 0, domain.ErrInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	// Same row lock Confirm takes, so a block is either seen by a running transfer or waits for it.
	if _, err = tx.ExecContext(ctx, `SELECT 1 FROM ledger.accounts WHERE id=$1 FOR UPDATE`, account); err != nil {
		return 0, err
	}
	var id int64
	var at time.Time
	err = tx.QueryRowContext(ctx, `INSERT INTO ledger.account_restrictions(account_id,kind,expires_at,reason,actor) VALUES($1,$2,$3,$4,$5) RETURNING id,created_at`,
		account, kind, expires, reason, actor).Scan(&id, &at)
	if err != nil {
		return 0, err
	}
	if err = publishRestriction(ctx, tx, "added", id, account, kind, expires, actor, at); err != nil {
		return 0, err
	}
	return id, tx.Commit()
}

func (s *Store) Lift(ctx context.Context, id int64, by string) error {
	if !domain.ValidID(by) {
		return domain.ErrInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var account, kind string
	var expires sql.NullTime
	var at time.Time
	err = tx.QueryRowContext(ctx, `UPDATE ledger.account_restrictions SET lifted_at=now(),lifted_by=$2 WHERE id=$1 AND lifted_at IS NULL RETURNING account_id,kind,expires_at,lifted_at`, id, by).
		Scan(&account, &kind, &expires, &at)
	if err == sql.ErrNoRows {
		return fmt.Errorf("restriction %d not found or already lifted", id)
	}
	if err != nil {
		return err
	}
	var exp *time.Time
	if expires.Valid {
		exp = &expires.Time
	}
	if err = publishRestriction(ctx, tx, "lifted", id, account, kind, exp, by, at); err != nil {
		return err
	}
	return tx.Commit()
}

// PublishExpired writes restriction.expired for every unlifted restriction whose time has passed.
// It is idempotent (fixed event ids) and run periodically by cmd/restriction-expire.
// shortcut: rescans all expired unlifted rows each run; add a watermark if that table gets large.
func (s *Store) PublishExpired(ctx context.Context) (int64, error) {
	r, err := s.db.ExecContext(ctx, `INSERT INTO ledger.outbox(id,payload,created_at,available_at,producer,kind)
		SELECT 'restriction:'||id||':expired',
		       jsonb_build_object('id',id,'account',account_id,'kind',kind,'expiresAt',expires_at,'actor','system'),
		       expires_at,expires_at,$1,'restriction.expired'
		FROM ledger.account_restrictions WHERE expires_at<=now() AND lifted_at IS NULL
		ON CONFLICT(id) DO NOTHING`, RestrictionTopic)
	if err != nil {
		return 0, err
	}
	return r.RowsAffected()
}

func (s *Store) Restrictions(ctx context.Context, account string) ([]Restriction, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,account_id,kind,reason,actor,created_at,expires_at,lifted_at,COALESCE(lifted_by,'')
		FROM ledger.account_restrictions WHERE account_id=$1 ORDER BY id`, account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Restriction
	for rows.Next() {
		var r Restriction
		var exp, lifted sql.NullTime
		if err = rows.Scan(&r.ID, &r.Account, &r.Kind, &r.Reason, &r.Actor, &r.CreatedAt, &exp, &lifted, &r.LiftedBy); err != nil {
			return nil, err
		}
		if exp.Valid {
			r.ExpiresAt = &exp.Time
		}
		if lifted.Valid {
			r.LiftedAt = &lifted.Time
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
