// identity-migrate applies Identity's own Goose migrations; it never changes accounts.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/voxel-vault/api/identity/adapters/postgres/migrations"
)

func run() error {
	dsn := os.Getenv("IDENTITY_DATABASE_URL")
	if dsn == "" {
		return fmt.Errorf("IDENTITY_DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return err
	}
	defer db.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err = migrations.Up(ctx, db); err != nil {
		return err
	}
	fmt.Println("Identity migrations are up to date.")
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Identity migration failed:", err)
		os.Exit(1)
	}
}
