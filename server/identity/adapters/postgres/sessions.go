package postgres

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/voxel-vault/api/identity/application"
	"github.com/voxel-vault/api/identity/domain"
)

type Store struct{ DB *sql.DB }

func (s Store) Read(ctx context.Context, id string) (domain.Session, error) {
	var row domain.Session
	err := s.DB.QueryRowContext(ctx, `SELECT id,subject,issuer,current_hash,created_at,expires_at,revoked_at,user_agent,ip FROM identity.sessions WHERE id=$1`, id).Scan(&row.ID, &row.Subject, &row.Issuer, &row.CurrentHash, &row.CreatedAt, &row.ExpiresAt, &row.RevokedAt, &row.UserAgent, &row.IP)
	if errors.Is(err, sql.ErrNoRows) {
		return row, domain.ErrUnauthenticated
	}
	return row, err
}

func (s Store) Create(ctx context.Context, row domain.Session, event application.Event) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO identity.sessions(id,subject,issuer,current_hash,created_at,expires_at,user_agent,ip) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, row.ID, row.Subject, row.Issuer, row.CurrentHash, row.CreatedAt, row.ExpiresAt, row.UserAgent, row.IP)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO identity.refresh_tokens(session_id,hash,issued_at) VALUES($1,$2,$3)`, row.ID, row.CurrentHash, row.CreatedAt); err != nil {
		return err
	}
	if err = appendEvent(ctx, tx, event); err != nil {
		return err
	}
	return tx.Commit()
}
func (s Store) Transact(ctx context.Context, id string, fn func(application.Tx) error) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var row domain.Session
	err = tx.QueryRowContext(ctx, `SELECT id,subject,issuer,current_hash,created_at,expires_at,revoked_at,user_agent,ip FROM identity.sessions WHERE id=$1 FOR UPDATE`, id).Scan(&row.ID, &row.Subject, &row.Issuer, &row.CurrentHash, &row.CreatedAt, &row.ExpiresAt, &row.RevokedAt, &row.UserAgent, &row.IP)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ErrUnauthenticated
	}
	if err != nil {
		return err
	}
	if err = fn(&unit{ctx: ctx, tx: tx, row: row}); err != nil {
		return err
	}
	return tx.Commit()
}

type unit struct {
	ctx context.Context
	tx  *sql.Tx
	row domain.Session
}

func (t *unit) Session() domain.Session {
	r := t.row
	if r.RevokedAt != nil {
		at := *r.RevokedAt
		r.RevokedAt = &at
	}
	return r
}
func (t *unit) KnownToken(hash string) (bool, error) {
	var known bool
	err := t.tx.QueryRowContext(t.ctx, `SELECT EXISTS(SELECT 1 FROM identity.refresh_tokens WHERE session_id=$1 AND hash=$2 AND consumed_at IS NOT NULL)`, t.row.ID, hash).Scan(&known)
	return known, err
}
func (t *unit) Save(row domain.Session, presented string, at time.Time, event application.Event) error {
	if row.ID != t.row.ID || row.Subject != t.row.Subject || row.Issuer != t.row.Issuer || event.SessionID != row.ID {
		return domain.ErrInvalid
	}
	if event.Kind == "refreshed" {
		result, err := t.tx.ExecContext(t.ctx, `UPDATE identity.refresh_tokens SET consumed_at=$3 WHERE session_id=$1 AND hash=$2 AND consumed_at IS NULL`, row.ID, presented, at)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return domain.ErrInvalid
		}
		if _, err = t.tx.ExecContext(t.ctx, `INSERT INTO identity.refresh_tokens(session_id,hash,issued_at) VALUES($1,$2,$3)`, row.ID, row.CurrentHash, at); err != nil {
			return err
		}
	} else if event.Kind != "revoked" && event.Kind != "replay_revoked" {
		return domain.ErrInvalid
	}
	if _, err := t.tx.ExecContext(t.ctx, `UPDATE identity.sessions SET current_hash=$2,revoked_at=$3 WHERE id=$1`, row.ID, row.CurrentHash, row.RevokedAt); err != nil {
		return err
	}
	if err := appendEvent(t.ctx, t.tx, event); err != nil {
		return err
	}
	t.row = row
	return nil
}
func appendEvent(ctx context.Context, tx *sql.Tx, event application.Event) error {
	if !domain.ValidID(event.SessionID) || !domain.ValidID(event.Cause.Actor) || !domain.ValidID(event.Cause.PolicyVersion) || event.At.IsZero() {
		return domain.ErrInvalid
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO identity.session_events(session_id,kind,at,actor,policy_version) VALUES($1,$2,$3,$4,$5)`, event.SessionID, event.Kind, event.At, event.Cause.Actor, event.Cause.PolicyVersion)
	return err
}

func (s Store) Exists(ctx context.Context, id string) (bool, error) {
	var exists bool
	err := s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM identity.accounts WHERE id=$1)`, id).Scan(&exists)
	return exists, err
}
