package migrations

import (
	"context"
	"database/sql"
)

func upLedger(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE wallet.journals (
 id text PRIMARY KEY, producer text NOT NULL, intent_id text NOT NULL,
 asset text NOT NULL, occurred_at timestamptz NOT NULL,
 UNIQUE(producer,intent_id), UNIQUE(id,asset),
 FOREIGN KEY(producer,intent_id) REFERENCES wallet.intents(producer,id)
);
CREATE TABLE wallet.postings (
 journal_id text NOT NULL, ordinal integer NOT NULL CHECK(ordinal>=0),
 account_id text NOT NULL, asset text NOT NULL, side text NOT NULL CHECK(side IN ('debit','credit')),
 units bigint NOT NULL CHECK(units>0), PRIMARY KEY(journal_id,ordinal),
 FOREIGN KEY(journal_id,asset) REFERENCES wallet.journals(id,asset),
 FOREIGN KEY(account_id,asset) REFERENCES wallet.accounts(id,asset)
);
CREATE INDEX wallet_postings_account ON wallet.postings(account_id);
`)
	return err
}
