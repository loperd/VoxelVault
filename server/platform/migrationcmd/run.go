// Package migrationcmd implements common lifecycle for explicit Go migration tools.
package migrationcmd

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func Run(variable, label string, up func(context.Context, *sql.DB) error) error {
	dsn := os.Getenv(variable)
	if dsn == "" {
		return fmt.Errorf("%s is required", variable)
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return err
	}
	defer db.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err = up(ctx, db); err != nil {
		return err
	}
	fmt.Printf("%s migrations are up to date.\n", label)
	return nil
}
