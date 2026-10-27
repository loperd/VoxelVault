// runtime-grants is an explicit offline operator tool. It neither creates login
// roles nor migrates schemas, and must never run in an API startup hook.
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	identitypg "github.com/voxel-vault/api/internal/identity/adapters/postgres"
	ipg "github.com/voxel-vault/api/internal/inventory/adapters/postgres"
	wpg "github.com/voxel-vault/api/internal/ledger/adapters/postgres"
	"github.com/voxel-vault/api/internal/platform/postgrespermissions"
	securitypg "github.com/voxel-vault/api/internal/security/adapters/postgres"
	"github.com/voxel-vault/api/internal/store"
)

func run(ctx context.Context, target, role string) error {
	var policy postgrespermissions.Policy
	var env string
	switch target {
	case "accounts":
		policy, env = store.RuntimePrivileges(), "DATABASE_URL"
	case "inventory":
		policy, env = ipg.RuntimePrivileges(), "INVENTORY_DATABASE_URL"
	case "wallet":
		policy, env = wpg.RuntimePrivileges(), "WALLET_DATABASE_URL"
	case "identity":
		policy, env = identitypg.RuntimePrivileges(), "IDENTITY_DATABASE_URL"
	case "security":
		policy, env = securitypg.RuntimePrivileges(), "SECURITY_DATABASE_URL"
	default:
		return fmt.Errorf("-context must be accounts, identity, security, inventory or wallet")
	}
	if os.Getenv(env) == "" {
		return fmt.Errorf("%s operator connection is required", env)
	}
	db, err := sql.Open("pgx", os.Getenv(env))
	if err != nil {
		return fmt.Errorf("invalid %s configuration", env)
	}
	defer db.Close()
	return postgrespermissions.Apply(ctx, db, role, policy)
}

func main() {
	target := flag.String("context", "", "accounts, identity, security, inventory or wallet")
	role := flag.String("role", "", "existing dedicated runtime role")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := run(ctx, *target, *role); err != nil {
		fmt.Fprintln(os.Stderr, "Runtime grants failed:", err)
		os.Exit(1)
	}
	fmt.Println("Context runtime grants applied and effective data privileges checked.")
}
