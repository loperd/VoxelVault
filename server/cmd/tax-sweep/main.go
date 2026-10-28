// tax-sweep moves the transfer tax collected on platform-tax into the treasury. It is
// one-shot and idempotent per hour: run it from a CronJob with the runtime WALLET_DATABASE_URL.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/voxel-vault/api/ledger/adapters/postgres"
)

func fail(args ...any) {
	fmt.Fprintln(os.Stderr, args...)
	os.Exit(1)
}

func main() {
	dsn := os.Getenv("WALLET_DATABASE_URL")
	if dsn == "" {
		fail("WALLET_DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		fail("invalid Wallet connection")
	}
	defer db.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	store := postgres.New(db)
	now := time.Now().UTC()
	// shortcut: one asset, the bundled "currency"; loop over the configured currencies when a second tax-bearing one exists.
	moved, err := store.SweepTreasury(ctx, "platform-tax", "treasury", "currency", now.Truncate(time.Hour), now)
	if err != nil {
		fail("tax sweep failed:", err)
	}
	fmt.Println("swept", moved)
}
