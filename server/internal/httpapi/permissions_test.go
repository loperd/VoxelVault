package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	ipg "github.com/voxel-vault/api/inventory/adapters/postgres"
	inv "github.com/voxel-vault/api/inventory/application"
	iv1 "github.com/voxel-vault/api/inventory/contracts/v1"
	idomain "github.com/voxel-vault/api/inventory/domain"
	wpg "github.com/voxel-vault/api/ledger/adapters/postgres"
	wmigrate "github.com/voxel-vault/api/ledger/adapters/postgres/migrations"
	"github.com/voxel-vault/api/platform/postgrespermissions"
)

func runtimeRole(t *testing.T, admin *sql.DB, dsn, suffix string, policy postgrespermissions.Policy) (*sql.DB, string, string) {
	t.Helper()
	name := fmt.Sprintf("context_runtime_%d_%d_%s", os.Getpid(), httpDBSeq.Add(1), suffix)
	quoted := pgx.Identifier{name}.Sanitize()
	httpExec(t, admin, `CREATE ROLE `+quoted+` LOGIN NOINHERIT PASSWORD 'runtime-test-only'`)
	t.Cleanup(func() {
		// Revoke this test role's grants in its own disposable database before
		// dropping the cluster role. It owns no database objects.
		if _, err := admin.Exec(`DROP OWNED BY ` + quoted); err != nil {
			t.Error(err)
		}
		if _, err := admin.Exec(`DROP ROLE ` + quoted); err != nil {
			t.Error(err)
		}
	})
	for range 2 {
		if err := postgrespermissions.Apply(context.Background(), admin, name, policy); err != nil {
			t.Fatal(err)
		}
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	u.User = url.UserPassword(name, "runtime-test-only")
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	var current string
	if err := db.QueryRow(`SELECT current_user`).Scan(&current); err != nil || current != name {
		t.Fatalf("runtime connection: %s, %v", current, err)
	}
	return db, u.String(), name
}

func assertDeniedSQL(t *testing.T, db *sql.DB, query string) {
	t.Helper()
	// Even an unexpected successful statement is rolled back, so checking denied
	// privileges cannot corrupt the shared test fixture.
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	_, err = tx.Exec(query)
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != "42501" {
		t.Fatalf("expected PostgreSQL insufficient_privilege for %s, got %v", query, err)
	}
}

func TestContextRuntimeWithDedicatedDatabaseRoles(t *testing.T) {
	f := httpStack(t, false)
	f.importItems(t)
	f.importChests(t)
	f.fundBuyback(t, 100)
	idb, inventoryDSN, inventoryRole := runtimeRole(t, f.idb, f.idsn, "inventory", ipg.RuntimePrivileges())
	wdb, walletDSN, walletRole := runtimeRole(t, f.wdb, f.wdsn, "wallet", wpg.RuntimePrivileges())
	f.idsn, f.wdsn = inventoryDSN, walletDSN
	f.activate(t)
	f.startWorker(t)
	decodeResponse(t, f.request("GET", "/readyz", "", "", ""), 200, nil)
	decodeResponse(t, f.request("GET", "/api/v1/me", "alice", "", ""), 200, nil)
	decodeResponse(t, f.request("POST", "/api/v1/auth/passkeys/register/options", "", "", `{"handle":"new-player","displayName":"New Player"}`), 404, nil)
	decodeResponse(t, f.request("GET", "/api/v1/inventory", "alice", "", ""), 200, nil)
	var repair iv1.Operation
	decodeResponse(t, f.request("POST", "/api/v1/inventory/items/alice-item/repair", "alice", "role-repair", "{}"), 202, &repair)
	f.wait(t, "alice", repair.ID, "completed")
	var initiator, recordedBy, permission, policyVersion string
	if err := idb.QueryRow(`SELECT cause->>'initiator',recorded_by,cause->>'permission',cause->>'policyVersion' FROM inventory.lifecycle_entries
 WHERE kind='operation' AND id=$1 AND cause->>'kind'='workshop_start'`, repair.ID).Scan(&initiator, &recordedBy, &permission, &policyVersion); err != nil || initiator != "alice" || recordedBy != inventoryRole || permission != string(inv.RepairItem) || policyVersion != "inventory-rbac-v1" {
		t.Fatalf("lifecycle attribution: initiator=%s role=%s err=%v", initiator, recordedBy, err)
	}
	if err := ipg.New(idb).Collection(context.Background(), func(tx inv.CollectionTx) error {
		c, err := tx.Chest("alice", "existing-chest")
		if err != nil {
			return err
		}
		c.State.Condition = 0.25
		return tx.SaveChest(c)
	}); !errors.Is(err, idomain.ErrInvalid) {
		t.Fatal("Go adapter accepted a write without lifecycle evidence", err)
	}
	var sell iv1.Operation
	decodeResponse(t, f.request("POST", "/api/v1/inventory/items/alice-item/sell", "alice", "role-sell", "{}"), 202, &sell)
	f.wait(t, "alice", sell.ID, "completed")
	decodeResponse(t, f.request("GET", "/api/v1/wallet", "alice", "", ""), 200, nil)
	decodeResponse(t, f.request("GET", "/api/v1/wallet/transactions", "alice", "", ""), 200, nil)
	// These are actual PostgreSQL privilege denials, not a trigger/domain failure.
	for _, c := range []struct {
		db *sql.DB
		q  string
	}{
		{idb, `CREATE TABLE inventory.runtime_probe(id int)`},
		{idb, `DELETE FROM inventory.items`},
		{idb, `UPDATE inventory.opening_baseline SET digest='bad'`},
		{idb, `UPDATE inventory.chest_baseline SET digest='bad'`},
		{idb, `UPDATE public.inventory_schema_version SET version_id=99`},
		{idb, `UPDATE inventory.lifecycle_entries SET cause='{}'`},
		{idb, `DELETE FROM inventory.lifecycle_links`},
		{wdb, `CREATE TABLE ledger.runtime_probe(id int)`},
		{wdb, `UPDATE ledger.journals SET intent_id='bad'`},
		{wdb, `DELETE FROM ledger.postings`},
		{wdb, `TRUNCATE ledger.journals CASCADE`},
		{wdb, `UPDATE ledger.opening_baseline SET digest='bad'`},
		{wdb, `UPDATE public.wallet_schema_version SET version_id=99`},
	} {
		assertDeniedSQL(t, c.db, c.q)
	}
	// An additional grant is rejected: nothing is silently revoked.
	httpExec(t, f.wdb, `GRANT UPDATE ON ledger.opening_baseline TO `+pgx.Identifier{walletRole}.Sanitize())
	if err := postgrespermissions.Apply(context.Background(), f.wdb, walletRole, wpg.RuntimePrivileges()); err == nil {
		t.Fatal("mutable opening baseline privilege accepted")
	}
}

func TestRuntimeGrantsRejectExcessRightsAtomically(t *testing.T) {
	admin, dsn := httpDatabase(t)
	ctx := context.Background()
	if err := wmigrate.Up(ctx, admin); err != nil {
		t.Fatal(err)
	}
	db, _, role := runtimeRole(t, admin, dsn, "audit", wpg.RuntimePrivileges())
	quoted := pgx.Identifier{role}.Sanitize()
	apply := func(allow bool) {
		t.Helper()
		err := postgrespermissions.Apply(ctx, admin, role, wpg.RuntimePrivileges())
		if (err == nil) != allow {
			t.Fatalf("expected grant success=%v, got %v", allow, err)
		}
	}
	httpExec(t, admin, `REVOKE SELECT ON ledger.journals FROM `+quoted)
	httpExec(t, admin, `GRANT UPDATE ON ledger.opening_baseline TO `+quoted)
	apply(false)
	// The failed operation must not leave its earlier GRANT statements committed.
	assertDeniedSQL(t, db, `SELECT * FROM ledger.journals`)
	httpExec(t, admin, `REVOKE UPDATE ON ledger.opening_baseline FROM `+quoted)
	apply(true)
	httpExec(t, admin, `GRANT SELECT ON ledger.journals TO `+quoted+` WITH GRANT OPTION`)
	apply(false)
	httpExec(t, admin, `REVOKE GRANT OPTION FOR SELECT ON ledger.journals FROM `+quoted)
	apply(true)
	httpExec(t, admin, `ALTER ROLE `+quoted+` CREATEDB`)
	apply(false)
	httpExec(t, admin, `ALTER ROLE `+quoted+` NOCREATEDB`)
	httpExec(t, admin, `GRANT SELECT ON ledger.opening_baseline TO PUBLIC`)
	apply(false)
	httpExec(t, admin, `REVOKE SELECT ON ledger.opening_baseline FROM PUBLIC`)
	var owner string
	if err := admin.QueryRow(`SELECT current_user`).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	httpExec(t, admin, `GRANT `+pgx.Identifier{owner}.Sanitize()+` TO `+quoted)
	apply(false)
	httpExec(t, admin, `REVOKE `+pgx.Identifier{owner}.Sanitize()+` FROM `+quoted)
	apply(true)
	if err := postgrespermissions.Apply(ctx, admin, owner, wpg.RuntimePrivileges()); err == nil {
		t.Fatal("owner/operator role accepted as a runtime identity")
	}
	if err := postgrespermissions.Apply(ctx, admin, "PUBLIC", wpg.RuntimePrivileges()); err == nil {
		t.Fatal("PUBLIC accepted as a runtime identity")
	}
}
