package migrations

import (
	"context"
	"database/sql"
)

func upSettlement(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE SCHEMA IF NOT EXISTS wallet;
CREATE TABLE wallet.accounts (
 id text PRIMARY KEY, subject text NOT NULL, asset text NOT NULL, role text NOT NULL,
 UNIQUE (subject,asset,role), UNIQUE (id,asset)
);
CREATE TABLE wallet.commands (
 producer text NOT NULL, id text NOT NULL, fingerprint text NOT NULL, receipt jsonb,
 PRIMARY KEY(producer,id)
);
CREATE TABLE wallet.intents (
 producer text NOT NULL, id text NOT NULL, body jsonb,
 PRIMARY KEY(producer,id)
);
CREATE TABLE wallet.holds (
 producer text NOT NULL, intent_id text NOT NULL, account_id text NOT NULL,
 units bigint NOT NULL CHECK(units>0),
 PRIMARY KEY(producer,intent_id),
 FOREIGN KEY(producer,intent_id) REFERENCES wallet.intents(producer,id),
 FOREIGN KEY(account_id) REFERENCES wallet.accounts(id)
);
CREATE INDEX wallet_holds_account ON wallet.holds(account_id);
`)
	return err
}
