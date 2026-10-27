// treasury-open allocates a pinned, one-time opening balance to an explicitly
// authorized treasury. It never migrates storage or refills a spent allocation.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/voxel-vault/api/internal/economyruntime"
	"github.com/voxel-vault/api/ledger/adapters/authorization"
	"github.com/voxel-vault/api/ledger/adapters/contract"
	"github.com/voxel-vault/api/ledger/adapters/postgres"
	"github.com/voxel-vault/api/ledger/application"
	"github.com/voxel-vault/api/ledger/domain"
	"github.com/voxel-vault/api/security/adapters/policyconfig"
)

func list(env string) []string {
	var out []string
	for _, v := range strings.Split(os.Getenv(env), ",") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func run(ctx context.Context, input application.TreasuryOpening) (application.Receipt, error) {
	maximum, err := domain.ParseUnits(os.Getenv("TREASURY_OPENING_MAX_UNITS"))
	if err != nil {
		return application.Receipt{}, fmt.Errorf("TREASURY_OPENING_MAX_UNITS must explicitly cap the allocation")
	}
	issuance, err := policyconfig.Load(os.Getenv("TREASURY_OPENING_AUTHORIZATION_POLICY"))
	if err != nil {
		return application.Receipt{}, err
	}
	policy, err := economyruntime.WalletAuthorizer(nil, []authorization.Grant{{Producer: "treasury-opening", Actions: []domain.Action{domain.FundTreasury}, Assets: list("TREASURY_OPENING_ASSETS"), Subjects: []string{"system"}, Purposes: []domain.Purpose{domain.TreasuryOpening}, Treasuries: list("TREASURY_OPENING_TREASURIES"), MaxUnits: maximum}}, issuance)
	if err != nil {
		return application.Receipt{}, fmt.Errorf("TREASURY_OPENING_ASSETS and TREASURY_OPENING_TREASURIES must explicitly scope funding")
	}
	dsn := os.Getenv("WALLET_DATABASE_URL")
	if dsn == "" {
		return application.Receipt{}, fmt.Errorf("WALLET_DATABASE_URL operator connection is required")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return application.Receipt{}, fmt.Errorf("invalid Wallet connection")
	}
	defer db.Close()
	return (application.TreasuryOpeningService{Store: postgres.New(db), Authorizer: policy, Producer: "treasury-opening", Clock: time.Now}).Open(ctx, input)
}

func main() {
	treasury := flag.String("treasury", "", "named treasury")
	asset := flag.String("asset", "", "funding asset")
	units := flag.String("units", "", "positive exact integer units")
	source := flag.String("source", "", "allocation source identity")
	reference := flag.String("reference", "", "allocation approval/reference identity")
	flag.Parse()
	value, err := domain.ParseUnits(*units)
	if err != nil {
		fmt.Fprintln(os.Stderr, "A positive exact -units value is required")
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	receipt, err := run(ctx, application.TreasuryOpening{Treasury: *treasury, Asset: *asset, Units: value, Source: *source, Reference: *reference})
	if err != nil {
		fmt.Fprintln(os.Stderr, "Treasury opening failed:", err)
		os.Exit(1)
	}
	if err = json.NewEncoder(os.Stdout).Encode(contract.Receipt(receipt)); err != nil {
		fmt.Fprintln(os.Stderr, "Treasury opening output failed:", err)
		os.Exit(1)
	}
}
