// economy-cutover exports a frozen legacy snapshot and imports offline context baselines.
// It never switches HTTP routes, reopens legacy writes or applies target migrations.
package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/voxel-vault/api/internal/economycutover"
	"github.com/voxel-vault/api/internal/economycutover/adapters/legacy"
	lmigrate "github.com/voxel-vault/api/internal/economycutover/adapters/legacy/migrations"
	"github.com/voxel-vault/api/internal/economyruntime"
	"github.com/voxel-vault/api/internal/rulebookjson"
	ilocal "github.com/voxel-vault/api/inventory/adapters/inbound/local"
	ipg "github.com/voxel-vault/api/inventory/adapters/postgres"
	inv "github.com/voxel-vault/api/inventory/application"
	"github.com/voxel-vault/api/ledger/adapters/authorization"
	wlocal "github.com/voxel-vault/api/ledger/adapters/inbound/local"
	wpg "github.com/voxel-vault/api/ledger/adapters/postgres"
	wallet "github.com/voxel-vault/api/ledger/application"
	"github.com/voxel-vault/api/ledger/domain"
	"github.com/voxel-vault/api/security/adapters/policyconfig"
)

func connect(ctx context.Context, env string) (*sql.DB, error) {
	dsn := os.Getenv(env)
	if dsn == "" {
		return nil, fmt.Errorf("%s is required", env)
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("invalid %s configuration", env)
	}
	if err = db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("%s is unavailable", env)
	}
	return db, nil
}

// Publish without overwriting another snapshot. The database also retains the exact
// artifact, so a filesystem failure after freeze can be recovered by exporting again.
func publish(path string, data []byte) error {
	if old, err := os.ReadFile(path); err == nil {
		if bytes.Equal(old, data) {
			return nil
		}
		return fmt.Errorf("manifest already exists with different contents")
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".economy-snapshot-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return os.Link(tmp.Name(), path)
}

func run(ctx context.Context, action, path, source string, out io.Writer) error {
	switch action {
	case "check":
		// Construct the same ports and guard as the API, but never run delivery or
		// migrate/import anything. This also works with read-only DB credentials.
		check, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		db, err := connect(check, "LEGACY_DATABASE_URL")
		if err != nil {
			return err
		}
		defer db.Close()
		config := strings.TrimSpace(os.Getenv("ECONOMY_CONFIG"))
		if config == "" {
			config = "config/economy.json"
		}
		rb, err := rulebookjson.Load(config)
		if err != nil {
			return err
		}
		var assets []string
		for _, asset := range strings.Split(os.Getenv("WALLET_ASSETS"), ",") {
			if asset = strings.TrimSpace(asset); asset != "" {
				assets = append(assets, asset)
			}
		}
		securityDB, err := connect(check, "SECURITY_DATABASE_URL")
		if err != nil {
			return err
		}
		defer securityDB.Close()
		runtime, err := economyruntime.New(check, db, os.Getenv("INVENTORY_DATABASE_URL"), os.Getenv("WALLET_DATABASE_URL"), assets, rb, economyruntime.Options{SecurityDB: securityDB})
		if err != nil {
			return err
		}
		defer runtime.Close()
		return json.NewEncoder(out).Encode(struct {
			Ready bool `json:"apiCutoverReady"`
		}{Ready: true})
	case "source-migrate":
		db, err := connect(ctx, "LEGACY_DATABASE_URL")
		if err != nil {
			return err
		}
		defer db.Close()
		if err = lmigrate.Up(ctx, db); err != nil {
			return err
		}
		fmt.Fprintln(out, "Legacy export barrier installed; writes remain enabled until export.")
		return nil
	case "export":
		if path == "" || source == "" {
			return fmt.Errorf("export requires -manifest and a stable -source identity")
		}
		db, err := connect(ctx, "LEGACY_DATABASE_URL")
		if err != nil {
			return err
		}
		defer db.Close()
		validator := ilocal.ChestsOpeningClient{}
		preflight := func(snapshot economycutover.Snapshot) error {
			request, err := legacy.ChestOpening(snapshot)
			if err != nil {
				return err
			}
			return validator.ValidateChestsOpening(ctx, request)
		}
		snapshot, err := (legacy.Source{DB: db, Preflight: preflight}).FreezeAndExport(ctx, source)
		if err != nil {
			return err
		}
		b, err := json.MarshalIndent(snapshot, "", "  ")
		if err != nil {
			return err
		}
		b = append(b, '\n')
		if err = publish(path, b); err != nil {
			return fmt.Errorf("legacy writes are frozen; rerun export to recover the stored snapshot: %w", err)
		}
		fmt.Fprintf(out, "Legacy writes frozen; snapshot %s saved to %s. API cutover is not ready.\n", snapshot.Digest, path)
		return nil
	case "import":
		if path == "" {
			return fmt.Errorf("import requires -manifest")
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		snapshot, err := economycutover.Decode(f)
		if err != nil {
			return err
		}
		var assets []string
		for _, a := range strings.Split(os.Getenv("CUTOVER_WALLET_ASSETS"), ",") {
			if a = strings.TrimSpace(a); a != "" {
				assets = append(assets, a)
			}
		}
		issuance, err := policyconfig.Load(os.Getenv("CUTOVER_WALLET_AUTHORIZATION_POLICY"))
		if err != nil {
			return err
		}
		policy, err := economyruntime.WalletAuthorizer(nil, []authorization.Grant{{Producer: "legacy-opening", Actions: []domain.Action{domain.Credit}, Assets: assets, AllSubjects: true, Purposes: []domain.Purpose{domain.OpeningBalance}}}, issuance)
		if err != nil {
			return fmt.Errorf("CUTOVER_WALLET_ASSETS must explicitly allow the imported assets")
		}
		wdb, err := connect(ctx, "WALLET_DATABASE_URL")
		if err != nil {
			return err
		}
		defer wdb.Close()
		idb, err := connect(ctx, "INVENTORY_DATABASE_URL")
		if err != nil {
			return err
		}
		defer idb.Close()
		w := wlocal.OpeningClient{Service: wallet.OpeningService{Store: wpg.New(wdb), Authorizer: policy, Producer: "legacy-opening"}}
		invAuth, err := economyruntime.InventoryAuthorizer(nil, strings.FieldsFunc(os.Getenv("CUTOVER_INVENTORY_SOURCES"), func(r rune) bool { return r == ',' || r == ' ' }))
		if err != nil {
			return err
		}
		ctx = economyruntime.OperatorContext(ctx)
		if _, err = invAuth.Authorize(ctx, inv.AccessRequest{Principal: inv.Principal{Kind: "operator", ID: economyruntime.MigrationPrincipal}, Permission: inv.ImportItems, Resource: inv.Resource{Kind: "baseline", ID: snapshot.Source, Source: snapshot.Source, Version: snapshot.Digest}}); err != nil {
			return err
		}
		i := ilocal.OpeningClient{Service: inv.OpeningService{Store: ipg.New(idb), Authorizer: invAuth}}
		report, importErr := economycutover.Apply(ctx, snapshot, w, i)
		if err = json.NewEncoder(out).Encode(report); err != nil {
			return err
		}
		return importErr
	case "import-chests":
		if path == "" {
			return fmt.Errorf("import-chests requires -manifest")
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		snapshot, err := economycutover.Decode(f)
		if err != nil {
			return err
		}
		request, err := legacy.ChestOpening(snapshot)
		if err != nil {
			return err
		}
		db, err := connect(ctx, "INVENTORY_DATABASE_URL")
		if err != nil {
			return err
		}
		defer db.Close()
		invAuth, err := economyruntime.InventoryAuthorizer(nil, strings.FieldsFunc(os.Getenv("CUTOVER_INVENTORY_SOURCES"), func(r rune) bool { return r == ',' || r == ' ' }))
		if err != nil {
			return err
		}
		ctx = economyruntime.OperatorContext(ctx)
		client := ilocal.ChestsOpeningClient{Service: inv.ChestsOpeningService{Store: ipg.New(db), Authorizer: invAuth}}
		if err = client.ImportChests(ctx, request); err != nil {
			return err
		}
		fmt.Fprintln(out, "Chest and starter-grant baseline imported. HTTP cutover is not activated.")
		return nil
	default:
		return fmt.Errorf("-action must be source-migrate, export, import, import-chests or check")
	}
}
func main() {
	action := flag.String("action", "", "source-migrate, export (freezes legacy writes), import, import-chests, or check (read-only readiness)")
	path := flag.String("manifest", "", "snapshot file path")
	source := flag.String("source", "", "stable identity of the legacy deployment")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, *action, *path, *source, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "Economy cutover failed:", err)
		os.Exit(1)
	}
}
