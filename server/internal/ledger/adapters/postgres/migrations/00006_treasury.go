package migrations

import (
	"context"
	"database/sql"
)

func upTreasury(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE wallet.treasury_openings(treasury text NOT NULL,asset text NOT NULL,fingerprint text NOT NULL,request jsonb NOT NULL,receipt jsonb,PRIMARY KEY(treasury,asset));`)
	return err
}
