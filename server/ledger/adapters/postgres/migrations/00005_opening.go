package migrations

import (
	"context"
	"database/sql"
)

func upOpening(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE wallet.opening_baseline (
 singleton boolean PRIMARY KEY CHECK(singleton),source text NOT NULL,digest text NOT NULL,payload jsonb NOT NULL
 );`)
	return err
}
