package migrations

import (
	"context"
	"database/sql"
	"github.com/voxel-vault/api/inventory/adapters/postgres"
)

func upLifecycle(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `
-- Snapshot existing rows and install capture while local writers are fenced.
LOCK TABLE inventory.operations,inventory.items,inventory.chests,inventory.collection_commands IN ACCESS EXCLUSIVE MODE;
CREATE TABLE inventory.instance_registry(
 kind text NOT NULL CHECK(kind IN ('item','chest','operation','collection_command')),
 id text NOT NULL,version bigint NOT NULL CHECK(version>0),snapshot jsonb NOT NULL,custody jsonb NOT NULL,
 PRIMARY KEY(kind,id), CHECK(custody->>'location' IN ('player','escrow','stock','archive','operation'))
);
CREATE TABLE inventory.lifecycle_entries(
 kind text NOT NULL,id text NOT NULL,version bigint NOT NULL CHECK(version>0),
 before_snapshot jsonb,after_snapshot jsonb NOT NULL,before_custody jsonb,after_custody jsonb NOT NULL,
 cause jsonb NOT NULL,recorded_by text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(kind,id,version),
 FOREIGN KEY(kind,id) REFERENCES inventory.instance_registry(kind,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE inventory.instance_registry ADD CONSTRAINT registry_history_head
 FOREIGN KEY(kind,id,version) REFERENCES inventory.lifecycle_entries(kind,id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX inventory_lifecycle_cause ON inventory.lifecycle_entries((cause->>'id'));
CREATE INDEX inventory_stock ON inventory.instance_registry((custody->>'location'),kind,id);
CREATE TABLE inventory.lifecycle_links(
 cause_id text NOT NULL,relation text NOT NULL CHECK(relation IN ('opened_into','merged_into')),
 from_kind text NOT NULL,from_id text NOT NULL,from_version bigint NOT NULL,
 to_kind text NOT NULL,to_id text NOT NULL,to_version bigint NOT NULL,
 PRIMARY KEY(cause_id,relation,from_kind,from_id,to_kind,to_id),
 FOREIGN KEY(from_kind,from_id,from_version) REFERENCES inventory.lifecycle_entries(kind,id,version),
 FOREIGN KEY(to_kind,to_id,to_version) REFERENCES inventory.lifecycle_entries(kind,id,version),
 CHECK(from_kind<>to_kind OR from_id<>to_id)
);

`)
	if err != nil {
		return err
	}
	return postgres.BootstrapLifecycle(ctx, tx)
}
