package migrations

import (
	"context"
	"database/sql"
	"errors"

	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

const VersionTable = "security_schema_version"

func Up(ctx context.Context, db *sql.DB) error {
	locker, err := lock.NewPostgresSessionLocker(lock.WithLockID(0x53454355524954))
	if err != nil {
		return err
	}
	p, err := goose.NewProvider(goose.DialectPostgres, db, nil, goose.WithDisableGlobalRegistry(true), goose.WithTableName(VersionTable), goose.WithSessionLocker(locker), goose.WithGoMigrations(goose.NewGoMigration(2, &goose.GoFunc{RunTx: upRoles}, nil), goose.NewGoMigration(1, &goose.GoFunc{RunTx: up}, &goose.GoFunc{RunTx: func(context.Context, *sql.Tx) error { return errors.New("security migrations are forward-only") }})))
	if err != nil {
		return err
	}
	_, err = p.Up(ctx)
	return err
}
func up(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE SCHEMA security;
CREATE TABLE security.role_bindings(subject text NOT NULL,role text NOT NULL,PRIMARY KEY(subject,role));
CREATE TABLE security.subject_registrations(subject text PRIMARY KEY,command_id text NOT NULL UNIQUE,role text NOT NULL,actor text NOT NULL,policy_version text NOT NULL,at timestamptz NOT NULL);`)
	return err
}

func upRoles(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE security.role_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,subject text NOT NULL,role text NOT NULL,actor text NOT NULL,policy_version text NOT NULL,at timestamptz NOT NULL);`)
	if err != nil {
		return err
	}
	var exists bool
	if err = tx.QueryRowContext(ctx, `SELECT to_regclass('public.casbin_rule') IS NOT NULL AND to_regclass('public.users') IS NOT NULL`).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return nil
	}
	_, err = tx.ExecContext(ctx, `LOCK TABLE public.casbin_rule IN EXCLUSIVE MODE;
 INSERT INTO security.role_bindings(subject,role) SELECT DISTINCT c.v0,c.v1 FROM public.casbin_rule c JOIN public.users u ON u.id=c.v0 WHERE c.ptype='g' ON CONFLICT DO NOTHING;
 INSERT INTO security.role_events(subject,role,actor,policy_version,at) SELECT subject,role,'identity-retirement','security-retirement-v1',now() FROM security.role_bindings;`)
	return err
}
