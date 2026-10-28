package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/voxel-vault/api/ledger/application"
	"github.com/voxel-vault/api/ledger/domain"
)

// OpenAccount is the only way a treasury account comes to exist; opening twice is harmless.
func (s *Store) OpenAccount(ctx context.Context, a domain.Account) error {
	if !domain.ValidID(a.Subject) || a.Role != "treasury_liability" || a != domain.TreasuryAccount(a.Subject, a.Asset) {
		return domain.ErrInvalid
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO ledger.accounts(id,subject,asset,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, a.ID, a.Subject, a.Asset, a.Role); err != nil {
		return err
	}
	if ok, err := s.HasAccount(ctx, a); err != nil || !ok {
		if err == nil {
			err = domain.ErrConflict
		}
		return err
	}
	return nil
}

// HasAccount reports whether the account row exists.
func (s *Store) HasAccount(ctx context.Context, a domain.Account) (bool, error) {
	var found bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ledger.accounts WHERE id=$1 AND subject=$2 AND asset=$3 AND role=$4)`, a.ID, a.Subject, a.Asset, a.Role).Scan(&found)
	return found, err
}

func (s *Store) SaveTransferQuote(ctx context.Context, q application.TransferQuote) error {
	raw, err := json.Marshal(q)
	if err != nil {
		return err
	}
	// Rows are never deleted, so both caps count rows created: quotes per second and a
	// daily total per subject. Completed and expired quotes still count.
	if s.quotesPerSecond < 1 || s.quotesPerDay < 1 {
		return application.ErrTransferRateLimit
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// The per-subject lock makes concurrent quotes see each other's rows, so the cap holds.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "quote:"+q.SenderID); err != nil {
		return err
	}
	res, err := tx.ExecContext(
		ctx,
		`INSERT INTO ledger.transfer_quotes(id,subject,asset,body,expires_at)
		 SELECT $1,$2,$3,$4::jsonb,$5 WHERE
		 (SELECT count(*) FROM ledger.transfer_quotes WHERE subject=$2
		  AND created_at > now() - interval '1 second') < $6 AND
		 (SELECT count(*) FROM ledger.transfer_quotes WHERE subject=$2
		  AND created_at > now() - interval '1 day') < $7`,
		q.ID,
		q.SenderID,
		q.CurrencyID,
		raw,
		q.ExpiresAt,
		s.quotesPerSecond,
		s.quotesPerDay,
	)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return application.ErrTransferRateLimit
	}
	return tx.Commit()
}

func readQuote(row *sql.Row) (application.TransferQuote, *application.TransferReceipt, error) {
	var raw, receipt []byte
	var q application.TransferQuote
	if err := row.Scan(&raw, &receipt); err == sql.ErrNoRows {
		return q, nil, application.ErrTransferNotFound
	} else if err != nil {
		return q, nil, err
	}
	if err := json.Unmarshal(raw, &q); err != nil {
		return q, nil, err
	}
	if receipt == nil {
		return q, nil, nil
	}
	var r application.TransferReceipt
	if err := json.Unmarshal(receipt, &r); err != nil {
		return q, nil, err
	}
	return q, &r, nil
}

func (s *Store) TransferQuote(
	ctx context.Context,
	id, subject string,
) (application.TransferQuote, *application.TransferReceipt, error) {
	return readQuote(
		s.db.QueryRowContext(
			ctx,
			`SELECT body,receipt FROM ledger.transfer_quotes WHERE id=$1 AND subject=$2`,
			id,
			subject,
		),
	)
}

func (t *unit) LockTransferQuote(
	id, subject string,
) (application.TransferQuote, *application.TransferReceipt, error) {
	return readQuote(
		t.tx.QueryRowContext(
			t.ctx,
			`SELECT body,receipt FROM ledger.transfer_quotes WHERE id=$1 AND subject=$2 FOR UPDATE`,
			id,
			subject,
		),
	)
}

func (s *Store) Transfer(ctx context.Context, fn func(application.TransferTx) error) error {
	return s.Transact(ctx, func(tx application.Tx) error { return fn(tx.(*unit)) })
}

func (s *Store) TransferDestination(ctx context.Context, id string) (domain.Account, bool, error) {
	return readAccount(
		s.db.QueryRowContext(
			ctx,
			`SELECT id,subject,asset,role,active FROM ledger.accounts WHERE id=$1`,
			id,
		),
	)
}

func (t *unit) Account(id string) (domain.Account, bool, error) {
	return readAccount(
		t.tx.QueryRowContext(
			t.ctx,
			`SELECT id,subject,asset,role,active FROM ledger.accounts WHERE id=$1`,
			id,
		),
	)
}

func readAccount(row *sql.Row) (domain.Account, bool, error) {
	var a domain.Account
	var active bool
	err := row.Scan(&a.ID, &a.Subject, &a.Asset, &a.Role, &active)
	if err == sql.ErrNoRows {
		return a, false, domain.ErrInvalid
	}
	return a, active, err
}

func (t *unit) CheckTransferKey(subject, key, fingerprint string) error {
	var existing string
	err := t.tx.QueryRowContext(t.ctx, `SELECT fingerprint FROM ledger.transfer_commands WHERE subject=$1 AND id=$2`, subject, key).Scan(&existing)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if existing != fingerprint {
		return domain.ErrConflict
	}
	return nil
}

func (t *unit) ClaimTransfer(
	subject, key, fingerprint string,
) (*application.TransferReceipt, error) {
	if _, err := t.tx.ExecContext(t.ctx, `INSERT INTO ledger.transfer_commands(subject,id,fingerprint)VALUES($1,$2,$3)ON CONFLICT DO NOTHING`, subject, key, fingerprint); err != nil {
		return nil, err
	}
	var existing string
	var raw []byte
	if err := t.tx.QueryRowContext(t.ctx, `SELECT fingerprint,receipt FROM ledger.transfer_commands WHERE subject=$1 AND id=$2 FOR UPDATE`, subject, key).Scan(&existing, &raw); err != nil {
		return nil, err
	}
	if existing != fingerprint {
		return nil, domain.ErrConflict
	}
	if raw == nil {
		return nil, nil
	}
	var r application.TransferReceipt
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

func (t *unit) CompleteTransfer(subject, key, quote string, r application.TransferReceipt) error {
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	for _, q := range []struct {
		sql string
		arg []any
	}{{`UPDATE ledger.transfer_quotes SET receipt=$3 WHERE id=$1 AND subject=$2 AND (receipt IS NULL OR receipt=$3::jsonb)`, []any{quote, subject, raw}}, {`UPDATE ledger.transfer_commands SET receipt=$3 WHERE subject=$1 AND id=$2 AND receipt IS NULL`, []any{subject, key, raw}}} {
		result, e := t.tx.ExecContext(t.ctx, q.sql, q.arg...)
		if e != nil {
			return e
		}
		n, e := result.RowsAffected()
		if e != nil {
			return e
		}
		if n != 1 {
			return domain.ErrConflict
		}
	}
	return nil
}

// clock_timestamp, not now(): a transaction older than a committed block must still see it.
const activeCondition = `created_at<=clock_timestamp() AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at>now())`
const activeRestriction = `SELECT EXISTS(SELECT 1 FROM ledger.account_restrictions WHERE account_id=$1 AND kind=$2 AND ` + activeCondition + `)`

// CheckTransferAllowed must run with both accounts locked, so a concurrent operator block
// (which takes the same lock) is either seen here or waits for this transfer.
func (t *unit) CheckTransferAllowed(subject, sender, recipient string) error {
	if t.s.transfersPerMinute < 1 || t.s.suspendMinutes < 1 {
		return application.ErrTransferRateLimit
	}
	// Per-subject lock: the cap spans currencies, whose account locks are disjoint.
	if _, err := t.tx.ExecContext(t.ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "transfer:"+subject); err != nil {
		return err
	}
	if err := checkRestrictions(t.ctx, t.tx, sender, recipient); err != nil {
		return err
	}
	var n int
	if err := t.tx.QueryRowContext(t.ctx, `SELECT count(*) FROM ledger.transfer_commands WHERE subject=$1 AND receipt IS NOT NULL AND created_at>now()-interval '1 minute'`, subject).Scan(&n); err != nil {
		return err
	}
	if n >= t.s.transfersPerMinute {
		return application.ErrTransferBurst
	}
	return nil
}

type rowQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// checkRestrictions: send block is ErrForbidden; receive block is neutral not-found.
func checkRestrictions(ctx context.Context, q rowQuerier, sender, recipient string) error {
	var blocked bool
	if err := q.QueryRowContext(ctx, activeRestriction, sender, "send").Scan(&blocked); err != nil {
		return err
	}
	if blocked {
		return application.ErrForbidden
	}
	if err := q.QueryRowContext(ctx, activeRestriction, recipient, "receive").Scan(&blocked); err != nil {
		return err
	}
	if blocked {
		return application.ErrTransferNotFound // neutral: sender learns nothing about block
	}
	return nil
}

// CheckRestrictions is the unlocked early check at Quote; Confirm repeats it under locks.
func (s *Store) CheckRestrictions(ctx context.Context, sender, recipient string) error {
	return checkRestrictions(ctx, s.db, sender, recipient)
}

// SuspendSender is called after a rejected Confirm rolled back; it is always time-limited.
func (s *Store) SuspendSender(ctx context.Context, account string) error {
	if s.suspendMinutes < 1 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "restrict:"+account); err != nil {
		return err
	}
	var id int64
	var expires, at time.Time
	err = tx.QueryRowContext(ctx, `INSERT INTO ledger.account_restrictions(account_id,kind,expires_at,reason,actor)
		SELECT $1,'send',now()+$2*interval '1 minute','too many confirmed transfers per minute','system'
		WHERE NOT EXISTS(SELECT 1 FROM ledger.account_restrictions WHERE account_id=$1 AND kind='send' AND `+activeCondition+`) RETURNING id,expires_at,created_at`, account, s.suspendMinutes).Scan(&id, &expires, &at)
	if err == sql.ErrNoRows {
		return nil // an active auto-block already exists
	}
	if err != nil {
		return err
	}
	if err = publishRestriction(ctx, tx, "added", id, account, "send", &expires, "system", at); err != nil {
		return err
	}
	return tx.Commit()
}
