// wallet-migrate applies the isolated Wallet context's versioned Goose migrations.
package main

import (
	"context"
	"database/sql"
	"fmt"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/voxel-vault/api/internal/ledger/adapters/postgres/migrations"
	"os"
	"os/signal"
	"syscall"
)

func run() error {
	dsn := os.Getenv("WALLET_DATABASE_URL")
	if dsn == "" {
		return fmt.Errorf("WALLET_DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return err
	}
	defer db.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := migrations.Up(ctx, db); err != nil {
		return err
	}
	fmt.Println("Wallet migrations are up to date.")
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Wallet migration failed:", err)
		os.Exit(1)
	}
}
