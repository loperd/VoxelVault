package migrations

import (
	"context"
	"database/sql"
)

// The history lookup uses the persisted event payload; keep its JSON paths indexed.
// https://www.postgresql.org/docs/15/indexes-expressional.html
// Move the existing book, including pending intents, holds and replay receipts,
// without copying or reinterpreting any financial value. Goose history and its
// session lock retain their original identities across the ownership change. The same
// migration adds transfers, restrictions and the generic outbox kind.
func upOwnership(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `ALTER SCHEMA wallet RENAME TO ledger;
ALTER TABLE ledger.accounts ADD COLUMN active boolean NOT NULL DEFAULT true;
-- Holds are never deleted: a hold ends as captured or released, only active ones reduce funds.
ALTER TABLE ledger.holds ADD COLUMN status text NOT NULL DEFAULT 'held' CHECK(status IN ('held','captured','released'));
-- kind separates receipt events from other facts that share the outbox (see platform/outbox).
ALTER TABLE ledger.outbox ADD COLUMN kind text NOT NULL DEFAULT 'ledger.journal.posted';
CREATE INDEX ledger_outbox_history ON ledger.outbox(producer,(payload#>>'{Receipt,Intent,ID}'),(payload#>>'{Receipt,Intent,State}'));
CREATE TABLE ledger.transfer_quotes(id text PRIMARY KEY,subject text NOT NULL,asset text NOT NULL,body jsonb NOT NULL,receipt jsonb,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL);
CREATE INDEX transfer_quotes_subject_created ON ledger.transfer_quotes(subject,created_at);
CREATE TABLE ledger.transfer_commands(subject text NOT NULL,id text NOT NULL,fingerprint text NOT NULL,receipt jsonb,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(subject,id));
CREATE INDEX transfer_commands_subject_created ON ledger.transfer_commands(subject,created_at);
-- Restrictions are never deleted or edited by the runtime role: only the operator sets lifted_at.
CREATE TABLE ledger.account_restrictions(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('send','receive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  reason text NOT NULL CHECK(reason<>''),
  actor text NOT NULL CHECK(actor<>''),
  lifted_at timestamptz,
  lifted_by text,
  CHECK((lifted_at IS NULL)=(lifted_by IS NULL))
);
CREATE INDEX account_restrictions_account ON ledger.account_restrictions(account_id,kind);
CREATE INDEX account_restrictions_expiry ON ledger.account_restrictions(expires_at) WHERE lifted_at IS NULL AND expires_at IS NOT NULL;`)
	return err
}
