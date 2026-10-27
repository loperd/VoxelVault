package migrations

import (
	"context"
	"database/sql"
)

func upCollection(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE inventory.owners(id text PRIMARY KEY,starter_granted_at timestamptz);
 CREATE TABLE inventory.chests(id text PRIMARY KEY,owner text NOT NULL REFERENCES inventory.owners(id),created_at timestamptz NOT NULL,body jsonb NOT NULL);
 CREATE INDEX inventory_chests_owner ON inventory.chests(owner,created_at,id);
 CREATE TABLE inventory.collection_commands(id text PRIMARY KEY,owner text NOT NULL REFERENCES inventory.owners(id),fingerprint text NOT NULL,result jsonb);
 CREATE TABLE inventory.chest_baseline(singleton boolean PRIMARY KEY CHECK(singleton),source text NOT NULL,digest text NOT NULL,payload jsonb NOT NULL);
 ALTER TABLE inventory.items DROP CONSTRAINT items_status_check;
 ALTER TABLE inventory.items DROP CONSTRAINT items_check;
 ALTER TABLE inventory.items ADD CONSTRAINT items_status_check CHECK(status IN ('available','locked','consumed','merged'));
 ALTER TABLE inventory.items ADD CONSTRAINT items_check CHECK(
 (status IN ('available','merged') AND operation_id IS NULL) OR (status IN ('locked','consumed') AND operation_id IS NOT NULL)
 );`)
	return err
}
