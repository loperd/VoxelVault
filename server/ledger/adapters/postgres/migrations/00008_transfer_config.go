package migrations

import (
	"context"
	"database/sql"
)

// Transfer configuration (currencies, commission rules, limits) lives in revisions that are
// never rewritten; the active pointer is the only mutable row.
func upTransferConfig(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `
CREATE TABLE ledger.transfer_config_revisions(
 version text PRIMARY KEY,document jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE ledger.transfer_config_active(
 singleton boolean PRIMARY KEY CHECK(singleton),version text NOT NULL REFERENCES ledger.transfer_config_revisions(version)
);`)
	return err
}
