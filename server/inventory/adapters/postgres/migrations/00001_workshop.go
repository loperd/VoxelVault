package migrations

import (
	"context"
	"database/sql"
)

func upWorkshop(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE SCHEMA IF NOT EXISTS inventory;
 CREATE TABLE inventory.operations(id text PRIMARY KEY,owner text NOT NULL,fingerprint text NOT NULL,body jsonb);
 CREATE TABLE inventory.items(
 id text PRIMARY KEY,owner text NOT NULL,definition text NOT NULL,condition text NOT NULL,origin text NOT NULL,
 status text NOT NULL CHECK(status IN ('available','locked','consumed')),
 operation_id text REFERENCES inventory.operations(id),
 CHECK((status='available' AND operation_id IS NULL) OR (status IN ('locked','consumed') AND operation_id IS NOT NULL))
 );
 CREATE INDEX inventory_items_owner ON inventory.items(owner,status);
 CREATE TABLE inventory.inbox(id text PRIMARY KEY,fingerprint text NOT NULL);
 CREATE TABLE inventory.outbox(
 id text PRIMARY KEY,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 available_at timestamptz NOT NULL DEFAULT now(),lease_owner text,lease_until timestamptz,
 lease_fence bigint NOT NULL DEFAULT 0,attempts integer NOT NULL DEFAULT 0,
 finished_at timestamptz,terminal_error text
 );
 CREATE INDEX inventory_outbox_pending ON inventory.outbox(available_at,created_at) WHERE finished_at IS NULL;`)
	return err
}
