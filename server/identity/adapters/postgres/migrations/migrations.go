// Package migrations owns Identity storage and its explicit Goose version history.
package migrations

import (
	"context"
	"database/sql"
	"errors"

	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

const VersionTable = "identity_schema_version"

func Provider(db *sql.DB) (*goose.Provider, error) {
	locker, err := lock.NewPostgresSessionLocker(lock.WithLockID(0x4944454e544954))
	if err != nil {
		return nil, err
	}
	down := &goose.GoFunc{RunTx: func(context.Context, *sql.Tx) error { return errors.New("identity migrations are forward-only") }}
	return goose.NewProvider(goose.DialectPostgres, db, nil, goose.WithDisableGlobalRegistry(true), goose.WithTableName(VersionTable), goose.WithSessionLocker(locker), goose.WithGoMigrations(goose.NewGoMigration(1, &goose.GoFunc{RunTx: up}, down), goose.NewGoMigration(2, &goose.GoFunc{RunTx: upAccounts}, down), goose.NewGoMigration(3, &goose.GoFunc{RunTx: retire}, down)))
}
func Up(ctx context.Context, db *sql.DB) error {
	p, err := Provider(db)
	if err != nil {
		return err
	}
	_, err = p.Up(ctx)
	return err
}
func up(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE SCHEMA identity;
CREATE TABLE identity.sessions(
 id text PRIMARY KEY,subject text NOT NULL,issuer text NOT NULL,current_hash text NOT NULL CHECK(length(current_hash)=64),
 created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,
 user_agent text NOT NULL,ip text NOT NULL,CHECK(expires_at>created_at)
);
CREATE INDEX ON identity.sessions(subject,created_at);
CREATE TABLE identity.refresh_tokens(
 session_id text NOT NULL REFERENCES identity.sessions(id),hash text NOT NULL CHECK(length(hash)=64),
 issued_at timestamptz NOT NULL,consumed_at timestamptz,PRIMARY KEY(session_id,hash)
);
CREATE TABLE identity.session_events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,session_id text NOT NULL REFERENCES identity.sessions(id),
 kind text NOT NULL CHECK(kind IN ('issued','refreshed','replay_revoked','revoked')),
 at timestamptz NOT NULL,actor text NOT NULL,policy_version text NOT NULL
);`)
	return err
}

func upAccounts(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE identity.accounts(id text PRIMARY KEY,handle text UNIQUE NOT NULL,display_name text NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE identity.provider_links(account_id text NOT NULL REFERENCES identity.accounts(id),provider text NOT NULL,external_id text NOT NULL,created_at timestamptz NOT NULL,PRIMARY KEY(provider,external_id));
CREATE TABLE identity.registrations(id text PRIMARY KEY,subject text NOT NULL UNIQUE REFERENCES identity.accounts(id),created_at timestamptz NOT NULL,completed_at timestamptz,receipt jsonb,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed','reconciliation')),attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),next_attempt_at timestamptz NOT NULL,last_error text NOT NULL DEFAULT '',CHECK((state='completed')=(completed_at IS NOT NULL)),CHECK((state='completed')=(receipt IS NOT NULL)));
CREATE TABLE identity.events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,subject text NOT NULL REFERENCES identity.accounts(id),kind text NOT NULL CHECK(kind IN ('created','linked','registration_completed','registration_retry','registration_conflict')),provider text NOT NULL,external_id text NOT NULL,actor text NOT NULL,policy_version text NOT NULL,at timestamptz NOT NULL,detail jsonb NOT NULL);
CREATE INDEX ON identity.registrations(next_attempt_at,id) WHERE state='pending';`)
	if err != nil {
		return err
	}
	if err = importAccounts(ctx, tx); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `ALTER TABLE identity.sessions ADD CONSTRAINT session_account FOREIGN KEY(subject) REFERENCES identity.accounts(id)`)
	return err
}
