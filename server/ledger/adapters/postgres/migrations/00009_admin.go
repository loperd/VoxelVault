package migrations

import (
	"context"
	"database/sql"
)

// Admin requests: a money or config action runs only after signatures from three distinct
// parties. Keys are public Ed25519 keys; the audit rows form a hash chain (prev_hash) that
// the runtime can append to but never rewrite.
func upAdmin(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `
CREATE TABLE ledger.admin_keys(
 key_id text PRIMARY KEY,party text NOT NULL,public_key bytea NOT NULL CHECK(length(public_key)=32)
);
CREATE TABLE ledger.admin_requests(
 id text PRIMARY KEY,action text NOT NULL,payload text NOT NULL,created_by text NOT NULL REFERENCES ledger.admin_keys(key_id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),executed_at timestamptz
);
CREATE TABLE ledger.admin_signatures(
 request_id text NOT NULL REFERENCES ledger.admin_requests(id),key_id text NOT NULL REFERENCES ledger.admin_keys(key_id),
 signature bytea NOT NULL CHECK(length(signature)=64),PRIMARY KEY(request_id,key_id)
);
CREATE TABLE ledger.admin_audit(
 seq bigserial PRIMARY KEY,event text NOT NULL,request_id text NOT NULL,key_id text NOT NULL,
 prev_hash bytea NOT NULL,hash bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);`)
	return err
}
