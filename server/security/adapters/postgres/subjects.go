package postgres

import (
	"context"
	"database/sql"
	"errors"
	"github.com/jackc/pgx/v5/pgconn"
	"time"

	"github.com/voxel-vault/api/security/application"
)

type Subjects struct{ DB *sql.DB }

// Receipt and first grant commit in one Security transaction. Replaying a receipt
// never inserts a missing/revoked role, even after default policy changes.
func (s Subjects) Register(ctx context.Context, input application.SubjectReceipt) (application.SubjectReceipt, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return application.SubjectReceipt{}, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `INSERT INTO security.subject_registrations(subject,command_id,role,actor,policy_version,at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(subject) DO NOTHING`, input.Subject, input.CommandID, input.Role, input.Actor, input.PolicyVersion, input.At)
	if err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" {
			return application.SubjectReceipt{}, application.ErrConflict
		}
		return application.SubjectReceipt{}, err
	}
	created, err := result.RowsAffected()
	if err != nil {
		return application.SubjectReceipt{}, err
	}
	var stored application.SubjectReceipt
	err = tx.QueryRowContext(ctx, `SELECT subject,command_id,role,actor,policy_version,at FROM security.subject_registrations WHERE subject=$1`, input.Subject).Scan(&stored.Subject, &stored.CommandID, &stored.Role, &stored.Actor, &stored.PolicyVersion, &stored.At)
	if err != nil {
		return stored, err
	}
	if stored.CommandID != input.CommandID || stored.Actor != input.Actor {
		return application.SubjectReceipt{}, application.ErrConflict
	}
	if created == 1 {
		if _, err = tx.ExecContext(ctx, `INSERT INTO security.role_bindings(subject,role) VALUES($1,$2) ON CONFLICT DO NOTHING`, stored.Subject, stored.Role); err != nil {
			return stored, err
		}
	}
	if err = tx.Commit(); err != nil {
		return application.SubjectReceipt{}, err
	}
	return stored, nil
}
func (s Subjects) Roles(ctx context.Context, subject string) ([]string, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT role FROM security.role_bindings WHERE subject=$1 ORDER BY role`, subject)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var role string
		if err = rows.Scan(&role); err != nil {
			return nil, err
		}
		out = append(out, role)
	}
	return out, rows.Err()
}

func (s Subjects) Assign(ctx context.Context, caller, target, role, version string, at time.Time, allowed func([]string) bool) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT role FROM security.role_bindings WHERE subject=$1 ORDER BY role FOR UPDATE`, caller)
	if err != nil {
		return err
	}
	var roles []string
	for rows.Next() {
		var v string
		if err = rows.Scan(&v); err != nil {
			rows.Close()
			return err
		}
		roles = append(roles, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if !allowed(roles) {
		return application.ErrForbidden
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO security.role_bindings(subject,role) VALUES($1,$2) ON CONFLICT DO NOTHING`, target, role)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 1 {
		_, err = tx.ExecContext(ctx, `INSERT INTO security.role_events(subject,role,actor,policy_version,at) VALUES($1,$2,$3,$4,$5)`, target, role, caller, version, at)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}
