package migrations

import (
	"context"
	"database/sql"
)

// An account always names its owner: the subject is never empty or oversized.
func upSubjectRequired(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `ALTER TABLE ledger.accounts ADD CONSTRAINT accounts_subject_valid CHECK(subject <> '' AND length(subject) <= 160)`)
	return err
}
