// economy-seed imports the bundled economy configuration and opens its accounts. It never
// replaces an active revision; changing the economy afterwards is an admin request.
package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/voxel-vault/api/internal/economyruntime"
	"github.com/voxel-vault/api/internal/rulebookjson"
	"github.com/voxel-vault/api/internal/securityruntime"
	ipg "github.com/voxel-vault/api/inventory/adapters/postgres"
	lpg "github.com/voxel-vault/api/ledger/adapters/postgres"
)

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	dsn := os.Getenv("INVENTORY_DATABASE_URL")
	if dsn == "" {
		return fmt.Errorf("INVENTORY_DATABASE_URL is required")
	}
	wdsn, sdsn := os.Getenv("WALLET_DATABASE_URL"), os.Getenv("SECURITY_DATABASE_URL")
	if wdsn == "" || sdsn == "" {
		return fmt.Errorf("WALLET_DATABASE_URL and SECURITY_DATABASE_URL are required")
	}
	dir := "config"
	if len(os.Args) > 1 {
		dir = os.Args[1]
	}
	doc, err := os.ReadFile(dir + "/economy.json")
	if err != nil {
		return err
	}
	rb, err := rulebookjson.Parse(doc)
	if err != nil {
		return err
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return fmt.Errorf("invalid INVENTORY_DATABASE_URL")
	}
	defer db.Close()
	if err = ipg.SeedRulebook(ctx, db, rb.Revision(), doc); err != nil {
		return err
	}
	fmt.Printf("Rulebook %s is stored.\n", rb.Revision())
	transfers, err := os.ReadFile(dir + "/transfers.json")
	if err != nil {
		return err
	}
	wdb, err := sql.Open("pgx", wdsn)
	if err != nil {
		return fmt.Errorf("invalid WALLET_DATABASE_URL")
	}
	defer wdb.Close()
	if err = economyruntime.SeedLedger(ctx, wdb, transfers); err != nil {
		return err
	}
	fmt.Println("Transfer configuration is stored and its accounts are open.")
	// ADMIN_KEYS=key_id:party:hex-public-key,... registers the parties that sign admin requests.
	for _, entry := range strings.Split(os.Getenv("ADMIN_KEYS"), ",") {
		if entry == "" {
			continue
		}
		parts := strings.Split(entry, ":")
		pub, err := hex.DecodeString(parts[len(parts)-1])
		if len(parts) != 3 || err != nil {
			return fmt.Errorf("ADMIN_KEYS entries are key_id:party:hex-public-key")
		}
		if err = lpg.New(wdb).RegisterAdminKey(ctx, parts[0], parts[1], pub); err != nil {
			return fmt.Errorf("admin key %s: %w", parts[0], err)
		}
		fmt.Printf("Admin key %s (%s) is registered.\n", parts[0], parts[1])
	}
	policy, err := os.ReadFile(dir + "/security.json")
	if err != nil {
		return err
	}
	sdb, err := sql.Open("pgx", sdsn)
	if err != nil {
		return fmt.Errorf("invalid SECURITY_DATABASE_URL")
	}
	defer sdb.Close()
	if err = securityruntime.SeedPolicy(ctx, sdb, policy); err != nil {
		return err
	}
	fmt.Println("Role policy is stored.")
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
