package migrations

import (
	"context"
	"database/sql"
)

func upDelivery(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `ALTER TABLE wallet.outbox
 ADD COLUMN producer text,
 ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN lease_owner text,
 ADD COLUMN lease_until timestamptz,
 ADD COLUMN lease_fence bigint NOT NULL DEFAULT 0,
 ADD COLUMN attempts integer NOT NULL DEFAULT 0,
 ADD COLUMN delivered_at timestamptz;
 UPDATE wallet.outbox SET producer=payload#>>'{Receipt,Intent,Producer}';
 ALTER TABLE wallet.outbox ALTER COLUMN producer SET NOT NULL;
 CREATE INDEX wallet_outbox_producer_pending ON wallet.outbox(producer,available_at,created_at) WHERE delivered_at IS NULL;
 CREATE INDEX wallet_outbox_pending ON wallet.outbox(available_at,created_at) WHERE delivered_at IS NULL;`)
	return err
}
