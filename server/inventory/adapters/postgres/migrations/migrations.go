package migrations

import (
	"context"
	"database/sql"
	"errors"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

func Provider(db *sql.DB) (*goose.Provider, error) {
	locker, err := lock.NewPostgresSessionLocker(lock.WithLockID(0x494e56454e54))
	if err != nil {
		return nil, err
	}
	return goose.NewProvider(goose.DialectPostgres, db, nil, goose.WithDisableGlobalRegistry(true), goose.WithTableName("inventory_schema_version"), goose.WithSessionLocker(locker),
		goose.WithGoMigrations(
			goose.NewGoMigration(1, &goose.GoFunc{RunTx: upWorkshop}, &goose.GoFunc{RunTx: func(context.Context, *sql.Tx) error { return errors.New("inventory migrations are forward-only") }}),
			goose.NewGoMigration(2, &goose.GoFunc{RunTx: upOpening}, &goose.GoFunc{RunTx: func(context.Context, *sql.Tx) error { return errors.New("inventory migrations are forward-only") }}),
			goose.NewGoMigration(3, &goose.GoFunc{RunTx: upCollection}, &goose.GoFunc{RunTx: func(context.Context, *sql.Tx) error { return errors.New("inventory migrations are forward-only") }}),
			goose.NewGoMigration(4, &goose.GoFunc{RunTx: upLifecycle}, &goose.GoFunc{RunTx: func(context.Context, *sql.Tx) error {
				return errors.New("inventory lifecycle migrations are forward-only")
			}})))
}

func Up(ctx context.Context, db *sql.DB) error {
	provider, err := Provider(db)
	if err != nil {
		return err
	}
	_, err = provider.Up(ctx)
	return err
}
