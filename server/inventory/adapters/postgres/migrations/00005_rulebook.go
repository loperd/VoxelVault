package migrations

import (
	"context"
	"database/sql"
)

func upRulebook(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `
CREATE TABLE inventory.rulebook_revisions(
 revision text PRIMARY KEY,document jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE inventory.rulebook_active(
 singleton boolean PRIMARY KEY CHECK(singleton),revision text NOT NULL REFERENCES inventory.rulebook_revisions(revision)
);`)
	return err
}
