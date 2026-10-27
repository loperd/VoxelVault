package migrations

import (
	"context"
	"database/sql"
)

func upOutbox(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE wallet.outbox (
 id text PRIMARY KEY, payload jsonb NOT NULL, created_at timestamptz NOT NULL
);
`)
	return err
}
