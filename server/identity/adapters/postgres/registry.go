package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/voxel-vault/api/identity/application"
	"github.com/voxel-vault/api/identity/domain"
)

// Registry owns accounts, provider links and durable registration state.
// Account creation is local to Identity; role provisioning uses a published port.
type Registry struct{ DB *sql.DB }

func (s Registry) RecipientCandidates(ctx context.Context, lookup application.RecipientLookup) ([]application.Profile, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id,handle,display_name FROM identity.accounts WHERE id=$1 OR handle=$1 OR id=$2 LIMIT 3`, lookup.Identifier, lookup.OpaqueHandleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	profiles := []application.Profile{}
	for rows.Next() {
		var p application.Profile
		if err := rows.Scan(&p.ID, &p.Handle, &p.DisplayName); err != nil {
			return nil, err
		}
		profiles = append(profiles, p)
	}
	return profiles, rows.Err()
}

func (s Registry) Exists(ctx context.Context, id string) (bool, error) {
	return (Store{DB: s.DB}).Exists(ctx, id)
}

func (s Registry) Resolve(
	ctx context.Context,
	p application.ProviderIdentity,
	id string,
	at time.Time,
	cause application.Cause,
) (application.Registration, error) {
	for attempt := 0; attempt < 5; attempt++ {
		r, err := s.resolve(ctx, p, id, at, cause)
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" {
			continue
		}
		return r, err
	}
	return application.Registration{}, application.ErrConflict
}

func (s Registry) resolve(
	ctx context.Context,
	p application.ProviderIdentity,
	id string,
	at time.Time,
	cause application.Cause,
) (application.Registration, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return application.Registration{}, err
	}
	defer tx.Rollback()
	var subject string
	err = tx.QueryRowContext(ctx, `SELECT u.id FROM identity.provider_links i JOIN identity.accounts u ON u.id=i.account_id WHERE i.provider=$1 AND i.external_id=$2`, p.Provider, p.ExternalID).
		Scan(&subject)
	if errors.Is(err, sql.ErrNoRows) {
		subject = id
		if _, err = tx.ExecContext(ctx, `INSERT INTO identity.accounts(id,handle,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$4)`, id, "u_"+id, p.DisplayName, at); err != nil {
			return application.Registration{}, err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO identity.provider_links(account_id,provider,external_id,created_at) VALUES($1,$2,$3,$4)`, id, p.Provider, p.ExternalID, at); err != nil {
			return application.Registration{}, err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO identity.registrations(id,subject,created_at,next_attempt_at) VALUES($1,$1,$2,$2)`, id, at); err != nil {
			return application.Registration{}, err
		}
		if err = registryEvent(ctx, tx, id, "created", p, cause, at, nil); err != nil {
			return application.Registration{}, err
		}
	} else if err != nil {
		return application.Registration{}, err
	}
	r := application.Registration{Subject: subject}
	var state string
	err = tx.QueryRowContext(ctx, `SELECT id,state FROM identity.registrations WHERE subject=$1`, subject).
		Scan(&r.ID, &state)
	if errors.Is(err, sql.ErrNoRows) {
		return r, application.ErrConflict
	}
	if err != nil {
		return r, err
	}
	if state == "reconciliation" {
		return r, application.ErrConflict
	}
	r.Pending = state == "pending"
	if err = tx.Commit(); err != nil {
		return application.Registration{}, err
	}
	return r, nil
}

func (s Registry) Link(
	ctx context.Context,
	subject string,
	p application.ProviderIdentity,
	at time.Time,
	cause application.Cause,
) (string, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var owner string
	if err = tx.QueryRowContext(ctx, `SELECT id FROM identity.accounts WHERE id=$1`, subject).Scan(&owner); errors.Is(
		err,
		sql.ErrNoRows,
	) {
		return "", domain.ErrUnauthenticated
	} else if err != nil {
		return "", err
	}
	result, err := tx.ExecContext(
		ctx,
		`INSERT INTO identity.provider_links(account_id,provider,external_id,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(provider,external_id) DO NOTHING`,
		subject,
		p.Provider,
		p.ExternalID,
		at,
	)
	if err != nil {
		return "", err
	}
	if err = tx.QueryRowContext(ctx, `SELECT account_id FROM identity.provider_links WHERE provider=$1 AND external_id=$2`, p.Provider, p.ExternalID).Scan(&owner); err != nil {
		return "", err
	}
	if owner != subject {
		return owner, nil
	}
	n, err := result.RowsAffected()
	if err != nil {
		return "", err
	}
	if n == 1 {
		if err = registryEvent(ctx, tx, subject, "linked", p, cause, at, nil); err != nil {
			return "", err
		}
	}
	return "", tx.Commit()
}

func (s Registry) Complete(
	ctx context.Context,
	r application.Registration,
	receipt application.RoleReceipt,
	at time.Time,
	cause application.Cause,
) error {
	raw, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(
		ctx,
		`UPDATE identity.registrations SET completed_at=$3,receipt=$4::jsonb,state='completed',last_error='' WHERE id=$1 AND subject=$2 AND state='pending'`,
		r.ID,
		r.Subject,
		at,
		raw,
	)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 1 {
		if err = registryEvent(ctx, tx, r.Subject, "registration_completed", application.ProviderIdentity{}, cause, at, receipt); err != nil {
			return err
		}
	}
	if n == 0 {
		var raw []byte
		if err = tx.QueryRowContext(ctx, `SELECT receipt FROM identity.registrations WHERE id=$1 AND subject=$2`, r.ID, r.Subject).Scan(&raw); err != nil {
			return application.ErrConflict
		}
		var prior application.RoleReceipt
		if json.Unmarshal(raw, &prior) != nil || prior != receipt {
			return application.ErrConflict
		}
	}
	return tx.Commit()
}

func (s Registry) Pending(
	ctx context.Context,
	at time.Time,
	limit int,
) ([]application.Registration, error) {
	rows, err := s.DB.QueryContext(
		ctx,
		`SELECT id,subject FROM identity.registrations WHERE state='pending' AND next_attempt_at<=$1 ORDER BY next_attempt_at,id LIMIT $2`,
		at,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []application.Registration{}
	for rows.Next() {
		r := application.Registration{Pending: true}
		if err = rows.Scan(&r.ID, &r.Subject); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s Registry) Failed(
	ctx context.Context,
	r application.Registration,
	permanent bool,
	at time.Time,
	cause application.Cause,
) error {
	state, kind, code := "pending", "registration_retry", "unavailable"
	if permanent {
		state, kind, code = "reconciliation", "registration_conflict", "conflict"
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(
		ctx,
		`UPDATE identity.registrations SET state=$3,attempts=attempts+1,next_attempt_at=$4,last_error=$5 WHERE id=$1 AND subject=$2 AND state='pending'`,
		r.ID,
		r.Subject,
		state,
		at.Add(5*time.Second),
		code,
	)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 1 {
		if err = registryEvent(ctx, tx, r.Subject, kind, application.ProviderIdentity{}, cause, at, map[string]string{"code": code}); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func registryEvent(
	ctx context.Context,
	tx *sql.Tx,
	subject, kind string,
	p application.ProviderIdentity,
	cause application.Cause,
	at time.Time,
	detail any,
) error {
	if !domain.ValidID(subject) || !domain.ValidID(cause.Actor) ||
		!domain.ValidID(cause.PolicyVersion) ||
		at.IsZero() {
		return domain.ErrInvalid
	}
	raw, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(
		ctx,
		`INSERT INTO identity.events(subject,kind,provider,external_id,actor,policy_version,at,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
		subject,
		kind,
		p.Provider,
		p.ExternalID,
		cause.Actor,
		cause.PolicyVersion,
		at,
		raw,
	)
	return err
}

func (r Registry) Profile(ctx context.Context, id string) (application.Profile, error) {
	var p application.Profile
	err := r.DB.QueryRowContext(ctx, `SELECT id,handle,display_name FROM identity.accounts WHERE id=$1`, id).
		Scan(&p.ID, &p.Handle, &p.DisplayName)
	if errors.Is(err, sql.ErrNoRows) {
		return p, domain.ErrUnauthenticated
	}
	return p, err
}
