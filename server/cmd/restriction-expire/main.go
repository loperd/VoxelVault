// restriction-expire publishes restriction.expired for restrictions whose time has passed.
// It is one-shot and idempotent: run it from a CronJob with the runtime WALLET_DATABASE_URL
// (SELECT on account_restrictions and INSERT on the outbox are enough).
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
	n, err := postgres.New(db).PublishExpired(ctx)
	if err != nil {
		fail("publish expired failed:", err)
	}
	fmt.Println("published", n)
}
