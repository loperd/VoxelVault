// Package migrations owns Wallet's versioned Goose Go migrations. It is separate from
// the runtime repository and the legacy API's AutoMigrate path.
package migrations

import (
	"context"
	"database/sql"
	"errors"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

const VersionTable = "wallet_schema_version"

func forwardOnly(context.Context, *sql.Tx) error {
	return errors.New("wallet ledger migrations are forward-only; use a new corrective migration")
}
func Provider(db *sql.DB) (*goose.Provider, error) {
	locker, err := lock.NewPostgresSessionLocker(lock.WithLockID(0x57414c4c4554))
	if err != nil {
		return nil, err
	}
	down := &goose.GoFunc{RunTx: forwardOnly}
	return goose.NewProvider(goose.DialectPostgres, db, nil,
		goose.WithDisableGlobalRegistry(true), goose.WithTableName(VersionTable), goose.WithSessionLocker(locker),
		goose.WithGoMigrations(
			goose.NewGoMigration(1, &goose.GoFunc{RunTx: upSettlement}, down),
			goose.NewGoMigration(2, &goose.GoFunc{RunTx: upLedger}, down),
			goose.NewGoMigration(3, &goose.GoFunc{RunTx: upOutbox}, down),
			goose.NewGoMigration(4, &goose.GoFunc{RunTx: upDelivery}, down),
			goose.NewGoMigration(5, &goose.GoFunc{RunTx: upOpening}, down),
			goose.NewGoMigration(6, &goose.GoFunc{RunTx: upTreasury}, down),
			goose.NewGoMigration(7, &goose.GoFunc{RunTx: upOwnership}, down),
		))
}
func Up(ctx context.Context, db *sql.DB) error {
	p, err := Provider(db)
	if err != nil {
		return err
	}
	_, err = p.Up(ctx)
	return err
}
