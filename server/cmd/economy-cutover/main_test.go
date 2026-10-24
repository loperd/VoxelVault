package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	cutover "github.com/voxel-vault/api/internal/economycutover"
	"github.com/voxel-vault/api/internal/economycutover/adapters/legacy"
	imigrate "github.com/voxel-vault/api/internal/inventory/adapters/postgres/migrations"
	"github.com/voxel-vault/api/internal/inventory/domain/chest"
	"github.com/voxel-vault/api/internal/rulebookjson"
	"github.com/voxel-vault/api/internal/security/adapters/policyconfig"
	security "github.com/voxel-vault/api/internal/security/application"
	"github.com/voxel-vault/api/internal/store"
	wmigrate "github.com/voxel-vault/api/internal/wallet/adapters/postgres/migrations"
)

func testDatabase(t *testing.T, suffix string) (*sql.DB, string) {
	t.Helper()
	dsn := os.Getenv("TEST_WALLET_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_WALLET_DATABASE_URL must allow disposable database creation")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("cutover_cli_%d_%s", os.Getpid(), suffix)
	if _, err = admin.Exec(`CREATE DATABASE ` + name + ` ENCODING 'UTF8' TEMPLATE template0`); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Close()
		if _, err := admin.Exec(`DROP DATABASE ` + name + ` WITH(FORCE)`); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	return db, u.String()
}

func readOnlyDSN(t *testing.T, dsn string) string {
	t.Helper()
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("default_transaction_read_only", "on")
	u.RawQuery = q.Encode()
	return u.String()
}

// Exercise the actual command dispatcher on independent databases. Readiness is
// tested under enforced read-only connections, including incomplete/invalid states.
func TestOfflineCutoverAndReadOnlyReadiness(t *testing.T) {
	ctx := context.Background()
	source, sourceDSN := testDatabase(t, "source")
	idb, inventoryDSN := testDatabase(t, "inventory")
	wdb, walletDSN := testDatabase(t, "wallet")
	g, err := store.Open(sourceDSN)
	if err != nil {
		t.Fatal(err)
	}
	gdb, err := g.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { gdb.Close() })
	at := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	for _, row := range []any{
		&store.EconomyOwner{ID: "alice", StarterGrantedAt: &at},
		&store.WalletBalance{UserID: "alice", Resource: "currency", Value: 9007199254740993},
		&store.InventoryItem{ID: "existing-item", UserID: "alice", ItemID: "historical-item", State: "heavy"},
	} {
		if err = g.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	config, err := filepath.Abs("../../config/economy.json")
	if err != nil {
		t.Fatal(err)
	}
	rb, err := rulebookjson.Load(config)
	if err != nil {
		t.Fatal(err)
	}
	c, err := chest.Issue(rb, chest.IssueRequest{ID: "existing-chest", Owner: "alice", Type: rb.Types()[0].ID, Source: "admin", Seed: 42})
	if err != nil {
		t.Fatal(err)
	}
	s := c.State()
	contents, _ := json.Marshal(s.Contents)
	traits, _ := json.Marshal(s.Traits)
	parents, _ := json.Marshal(s.Origin.Parents)
	row := store.ChestInstance{ID: s.ID, UserID: s.Owner, CaseID: s.Type, Status: string(s.Status), Seed: int64(s.Seed), Revision: s.Revision,
		Contents: contents, Traits: traits, Rarity: s.Rarity, Condition: s.Condition, OriginSource: s.Origin.Source, OriginParents: parents}
	if err = g.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	assets := []string{"currency"}
	for _, kind := range rb.Types() {
		assets = append(assets, rb.Material(kind))
	}
	t.Setenv("LEGACY_DATABASE_URL", sourceDSN)
	t.Setenv("SECURITY_DATABASE_URL", sourceDSN)
	t.Setenv("INVENTORY_DATABASE_URL", inventoryDSN)
	t.Setenv("WALLET_DATABASE_URL", walletDSN)
	t.Setenv("WALLET_ASSETS", strings.Join(assets, ","))
	t.Setenv("CUTOVER_WALLET_ASSETS", strings.Join(assets, ","))
	t.Setenv("ECONOMY_CONFIG", config)
	t.Setenv("CUTOVER_INVENTORY_SOURCES", "cli-rehearsal")
	manifest := filepath.Join(t.TempDir(), "snapshot.json")
	command := func(action string) []byte {
		t.Helper()
		var out bytes.Buffer
		if err := run(ctx, action, manifest, "cli-rehearsal", &out); err != nil {
			t.Fatalf("%s: %v", action, err)
		}
		return out.Bytes()
	}
	check := func(t *testing.T, ready bool) {
		t.Helper()
		t.Setenv("LEGACY_DATABASE_URL", readOnlyDSN(t, sourceDSN))
		t.Setenv("SECURITY_DATABASE_URL", readOnlyDSN(t, sourceDSN))
		t.Setenv("INVENTORY_DATABASE_URL", readOnlyDSN(t, inventoryDSN))
		t.Setenv("WALLET_DATABASE_URL", readOnlyDSN(t, walletDSN))
		var out bytes.Buffer
		err := run(ctx, "check", "", "", &out)
		if !ready {
			if err == nil || out.Len() != 0 {
				t.Fatalf("incomplete check: err=%v output=%q", err, out.String())
			}
			return
		}
		if err != nil {
			t.Fatal(err)
		}
		var report struct {
			Ready bool `json:"apiCutoverReady"`
		}
		if err := json.Unmarshal(out.Bytes(), &report); err != nil || !report.Ready {
			t.Fatalf("readiness report: %s, %v", out.String(), err)
		}
	}
	t.Run("unmigrated targets rejected", func(t *testing.T) { check(t, false) })
	for _, target := range []struct {
		db *sql.DB
		up func(context.Context, *sql.DB) error
	}{{idb, imigrate.Up}, {wdb, wmigrate.Up}} {
		if err := target.up(ctx, target.db); err != nil {
			t.Fatal(err)
		}
		// Re-running the separately packaged migrators must be harmless.
		if err := target.up(ctx, target.db); err != nil {
			t.Fatal(err)
		}
	}
	command("source-migrate")
	t.Run("unfrozen source rejected", func(t *testing.T) { check(t, false) })
	var frozen bool
	if err := source.QueryRow(`SELECT frozen FROM legacy_economy_cutover.snapshot`).Scan(&frozen); err != nil || frozen {
		t.Fatalf("readiness must not freeze source: %v, %v", frozen, err)
	}
	command("export")
	first, err := os.ReadFile(manifest)
	if err != nil {
		t.Fatal(err)
	}
	approved, err := cutover.Decode(bytes.NewReader(first))
	if err != nil {
		t.Fatal(err)
	}
	policy := policyconfig.Policy{Version: "cli-approval-v1", Bindings: []policyconfig.Binding{{Kind: "operator", ID: "legacy-opening", Roles: []string{"baseline-importer"}}}}
	for _, permission := range []string{"wallet.issue.opening_balance", "wallet.issue.opening_balance.asset"} {
		policy.Rules = append(policy.Rules, security.Rule{Context: "wallet", Role: "baseline-importer", ActorKind: "operator", Permission: permission, ResourceKind: "issuance", Scope: security.ResourceScope, ResourceIDs: []string{"cli-rehearsal"}, Attributes: map[string]security.Constraint{"reference": {Values: []string{approved.Digest}}, "treasury": {Values: []string{""}}}})
	}
	policy.Rules[1].Attributes["asset"] = security.Constraint{Values: assets}
	policy.Rules[1].Attributes["units"] = security.Constraint{Maximum: "9007199254740993"}
	rawPolicy, err := json.Marshal(policy)
	if err != nil {
		t.Fatal(err)
	}
	policyPath := filepath.Join(t.TempDir(), "authorization.json")
	if err = os.WriteFile(policyPath, rawPolicy, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CUTOVER_WALLET_AUTHORIZATION_POLICY", policyPath)
	command("export")
	second, err := os.ReadFile(manifest)
	if err != nil || !bytes.Equal(first, second) {
		t.Fatal("retried export changed the snapshot", err)
	}
	if info, err := os.Stat(manifest); err != nil || info.Mode().Perm()&0077 != 0 {
		t.Fatal("snapshot must remain private", err)
	}
	t.Run("missing baselines rejected", func(t *testing.T) { check(t, false) })
	t.Run("missing issuance policy cannot partially fund wallet", func(t *testing.T) {
		t.Setenv("CUTOVER_WALLET_AUTHORIZATION_POLICY", "")
		var out bytes.Buffer
		if err := run(ctx, "import", manifest, "cli-rehearsal", &out); err == nil {
			t.Fatal("missing issuance policy allowed import")
		}
		var journals int
		if err := wdb.QueryRow(`SELECT count(*) FROM wallet.journals`).Scan(&journals); err != nil || journals != 0 {
			t.Fatal("unapproved import changed Wallet", journals, err)
		}
	})
	t.Run("unscoped import cannot partially fund wallet", func(t *testing.T) {
		t.Setenv("CUTOVER_INVENTORY_SOURCES", "")
		var out bytes.Buffer
		if err := run(ctx, "import", manifest, "cli-rehearsal", &out); err == nil {
			t.Fatal("unscoped inventory import allowed")
		}
		var journals int
		if err := wdb.QueryRow(`SELECT count(*) FROM wallet.journals`).Scan(&journals); err != nil || journals != 0 {
			t.Fatal("unauthorized import changed Wallet", journals, err)
		}
	})
	command("import")
	command("import")
	t.Run("missing chests rejected", func(t *testing.T) { check(t, false) })
	command("import-chests")
	command("import-chests")
	t.Run("complete read-only readiness", func(t *testing.T) { check(t, true) })
	for _, row := range []struct {
		db    *sql.DB
		query string
		want  string
	}{
		{wdb, `SELECT sum(p.units)::text FROM wallet.postings p JOIN wallet.accounts a ON a.id=p.account_id WHERE a.role='player_liability' AND p.side='credit'`, "9007199254740993"},
		{wdb, `SELECT count(*)::text FROM wallet.journals`, "1"},
		{idb, `SELECT count(*)::text FROM inventory.items`, "1"},
		{idb, `SELECT count(*)::text FROM inventory.chests`, "1"},
		{idb, `SELECT count(*)::text FROM inventory.collection_commands`, "0"},
	} {
		var got string
		if err := row.db.QueryRow(row.query).Scan(&got); err != nil || got != row.want {
			t.Fatalf("%s: got %s want %s, %v", row.query, got, row.want, err)
		}
	}
	write, err := source.Begin()
	if err != nil {
		t.Fatal(err)
	}
	guardErr := legacy.GuardWrite(ctx, write)
	write.Rollback()
	if guardErr == nil {
		t.Fatal("source writes must remain fenced")
	}
	snapshot, err := cutover.Decode(bytes.NewReader(first))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := idb.Exec(`UPDATE inventory.chest_baseline SET digest='mismatched'`); err != nil {
		t.Fatal(err)
	}
	t.Run("mismatched digest rejected", func(t *testing.T) { check(t, false) })
	if _, err := idb.Exec(`UPDATE inventory.chest_baseline SET digest=$1`, snapshot.Digest); err != nil {
		t.Fatal(err)
	}
	t.Run("missing material rejected", func(t *testing.T) {
		t.Setenv("WALLET_ASSETS", "currency")
		check(t, false)
	})
	t.Run("ready after checks", func(t *testing.T) { check(t, true) })
}
