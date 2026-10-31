// legacy-drop removes the retired pre-context economy storage from the old accounts database:
// the public chest, item, wallet and owner tables and the legacy_economy_cutover schema.
// It is a one-off operator tool, run once after a backup; the data lives on in the Inventory
// and Wallet baselines. Delete it in the release after the drop.
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"os"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

var tables = []string{"chest_instances", "inventory_items", "wallet_balances", "economy_owners", "loot_items", "chest_types"}

func run(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, table := range tables {
		var exists bool
		if err = tx.QueryRowContext(ctx, `SELECT to_regclass('public.'||$1) IS NOT NULL`, table).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			continue
		}
		var rows int
		if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM public.`+table).Scan(&rows); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `DROP TABLE public.`+table); err != nil {
			return err
		}
		fmt.Printf("dropped public.%s (%d rows)\n", table, rows)
	}
	if _, err = tx.ExecContext(ctx, `DROP SCHEMA IF EXISTS legacy_economy_cutover CASCADE`); err != nil {
		return err
	}
	return tx.Commit()
}

func main() {
	backup := flag.Bool("backup-taken", false, "confirm the database has been backed up; the drop cannot be undone")
	flag.Parse()
	dsn := os.Getenv("DATABASE_URL")
	if !*backup || dsn == "" {
		fmt.Fprintln(os.Stderr, "Legacy drop needs DATABASE_URL (operator connection) and -backup-taken")
		os.Exit(2)
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Invalid DATABASE_URL")
		os.Exit(1)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err = run(ctx, db); err != nil {
		fmt.Fprintln(os.Stderr, "Legacy drop failed:", err)
		os.Exit(1)
	}
}
