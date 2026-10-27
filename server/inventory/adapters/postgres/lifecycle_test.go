package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/voxel-vault/api/inventory/adapters/postgres/migrations"
	"github.com/voxel-vault/api/inventory/application"
	"github.com/voxel-vault/api/inventory/domain"
)

func scalar(t *testing.T, f *fixture, q string, args ...any) string {
	t.Helper()
	var got string
	if err := f.db.QueryRow(q, args...).Scan(&got); err != nil {
		t.Fatal(err)
	}
	return got
}

func verifyHistory(t *testing.T, f *fixture) {
	t.Helper()
	for _, q := range []string{
		`SELECT count(*)::text FROM inventory.instance_registry r JOIN inventory.lifecycle_entries e USING(kind,id,version)
 WHERE r.snapshot<>e.after_snapshot OR r.custody<>e.after_custody`,
		`SELECT count(*)::text FROM (SELECT *,lag(after_snapshot) OVER w previous_snapshot,
 lag(after_custody) OVER w previous_custody,lag(version) OVER w previous_version
 FROM inventory.lifecycle_entries WINDOW w AS(PARTITION BY kind,id ORDER BY version)) h
 WHERE (version=1 AND (before_snapshot IS NOT NULL OR before_custody IS NOT NULL))
 OR (version>1 AND (previous_version<>version-1 OR before_snapshot IS DISTINCT FROM previous_snapshot OR before_custody IS DISTINCT FROM previous_custody))`,
		`SELECT count(*)::text FROM inventory.items i LEFT JOIN inventory.instance_registry r ON r.kind='item' AND r.id=i.id
 WHERE r.id IS NULL OR r.snapshot<>to_jsonb(i)`,
		`SELECT count(*)::text FROM inventory.chests c LEFT JOIN inventory.instance_registry r ON r.kind='chest' AND r.id=c.id
 WHERE r.id IS NULL OR r.snapshot<>to_jsonb(c)`,
	} {
		if got := scalar(t, f, q); got != "0" {
			t.Fatalf("history invariant: %s: %s", q, got)
		}
	}
}

func openTrackedItem(t *testing.T, f *fixture, request string) domain.Item {
	t.Helper()
	id := f.issue(t, request, 1)[0].State.ID
	if _, _, err := f.service.Claim(ctx, "player", id, request); err != nil {
		t.Fatal(err)
	}
	c, err := f.service.Open(ctx, "player", id, request)
	if err != nil || c.Reward == nil {
		t.Fatal(c, err)
	}
	return *c.Reward
}

type lifecyclePrices struct{}

func (lifecyclePrices) Quote(_ domain.Item, a domain.Action) (domain.Quote, error) {
	asset := "coins"
	if a == domain.Salvage {
		asset = "material"
	}
	return domain.Quote{Asset: asset, Units: 4, Revision: "v1"}, nil
}

func award(op domain.Operation, outcome domain.Outcome, version uint64) domain.SettlementFact {
	purpose := "reward"
	if op.Action == domain.Sell {
		purpose = "buyback"
	}
	return domain.SettlementFact{IntentID: op.ID, Version: version, Outcome: outcome,
		Terms: &domain.SettlementTerms{Owner: op.Owner, Asset: op.Quote.Asset, Units: op.Quote.Units, Evidence: op.Evidence(), Purpose: purpose}}
}

func TestLifecycleSeparatesStockFromIrreversibleBurn(t *testing.T) {
	for _, action := range []domain.Action{domain.Sell, domain.Salvage} {
		t.Run(string(action), func(t *testing.T) {
			f := stack(t)
			item := openTrackedItem(t, f, "issue")
			service, err := application.New(f.store, lifecyclePrices{}, allowInventory{})
			if err != nil {
				t.Fatal(err)
			}
			op, err := service.Start(ctx, application.Request{Owner: "player", RequestID: "work", ItemID: item.ID, Action: action})
			if err != nil {
				t.Fatal(err)
			}
			if got := scalar(t, f, `SELECT custody->>'location' FROM inventory.instance_registry WHERE kind='item' AND id=$1`, item.ID); got != "escrow" {
				t.Fatal("unsettled item escaped escrow", got)
			}
			fact := award(op, domain.AwardRecorded, 1)
			if err := service.Observe(ctx, "award", fact); err != nil {
				t.Fatal(err)
			}
			before := count(t, f.db, "lifecycle_entries")
			if err := service.Observe(ctx, "award", fact); err != nil {
				t.Fatal(err)
			}
			if err := service.Observe(ctx, "duplicate-fact", fact); err != nil {
				t.Fatal(err)
			}
			if count(t, f.db, "lifecycle_entries") != before {
				t.Fatal("duplicate settlement appended duplicate history")
			}
			want := "stock"
			if action == domain.Salvage {
				want = "archive"
			}
			if got := scalar(t, f, `SELECT custody->>'location' FROM inventory.instance_registry WHERE kind='item' AND id=$1`, item.ID); got != want {
				t.Fatal(got, want)
			}
			if action == domain.Salvage {
				if got := scalar(t, f, `SELECT custody->>'disposition' FROM inventory.instance_registry WHERE kind='item' AND id=$1`, item.ID); got != "burned" {
					t.Fatal(got)
				}
				completed, err := service.Operation(ctx, "player", op.ID)
				if err != nil {
					t.Fatal(err)
				}
				live := item
				live.Status = domain.Consumed
				live.OperationID = op.ID
				restored := live
				restored.Status = domain.Available
				restored.OperationID = ""
				repaired := live
				repaired.Condition = "broken"
				if live.Condition == "broken" {
					repaired.Condition = "intact"
				}
				for _, bad := range []domain.Item{restored, repaired} {
					err := f.store.Transact(ctx, func(tx application.Tx) error { return tx.Save(completed, bad) })
					if !errors.Is(err, domain.ErrConflict) {
						t.Fatal("Go adapter accepted burn resurrection", err)
					}
				}
			}
			if _, err := service.Start(ctx, application.Request{Owner: "player", RequestID: "reuse", ItemID: item.ID, Action: domain.Sell}); !errors.Is(err, domain.ErrBusy) {
				t.Fatal("retired/stock instance reused from old player inventory", err)
			}
			if err := service.Observe(ctx, "late-closed", award(op, domain.AwardClosed, 2)); !errors.Is(err, domain.ErrConflict) {
				t.Fatal("late compensation reversed a completed operation", err)
			}
			if count(t, f.db, "items") != 1 || scalar(t, f, `SELECT count(*)::text FROM inventory.lifecycle_links WHERE relation='opened_into' AND to_id=$1`, item.ID) != "1" {
				t.Fatal("instance identity or birth lineage lost")
			}
			verifyHistory(t, f)
		})
	}
}

func TestLifecyclePendingSalvageCanRestoreOnlyAfterCloseFence(t *testing.T) {
	f := stack(t)
	item := openTrackedItem(t, f, "issue")
	service, err := application.New(f.store, lifecyclePrices{}, allowInventory{})
	if err != nil {
		t.Fatal(err)
	}
	op, err := service.Start(ctx, application.Request{Owner: "player", RequestID: "salvage", ItemID: item.ID, Action: domain.Salvage})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Observe(ctx, "rejected", award(op, domain.AwardRejected, 1)); err != nil {
		t.Fatal(err)
	}
	if got := scalar(t, f, `SELECT custody->>'location' FROM inventory.instance_registry WHERE kind='item' AND id=$1`, item.ID); got != "escrow" {
		t.Fatal(got)
	}
	if err := service.Observe(ctx, "closed", award(op, domain.AwardClosed, 2)); err != nil {
		t.Fatal(err)
	}
	if got := scalar(t, f, `SELECT custody->>'location' FROM inventory.instance_registry WHERE kind='item' AND id=$1`, item.ID); got != "player" {
		t.Fatal(got)
	}
	if got := scalar(t, f, `SELECT count(*)::text FROM inventory.lifecycle_entries WHERE kind='item' AND id=$1 AND after_custody->>'disposition'='burned'`, item.ID); got != "0" {
		t.Fatal("a failed pre-burn operation was recorded as a completed burn")
	}
	verifyHistory(t, f)
}

func TestLifecycleHistoryIsAtomicImmutableAndLinkedAcrossMerges(t *testing.T) {
	f := stack(t)
	chests := f.issue(t, "parents", 2)
	before := count(t, f.db, "lifecycle_entries")
	if _, err := f.service.Issue(ctx, application.IssueRequest{Owner: "player", RequestID: "parents", Type: "ender", Source: "admin", Count: 2}); err != nil || count(t, f.db, "lifecycle_entries") != before {
		t.Fatal("issuance retry changed history", err)
	}
	merged, err := f.service.MergeChests(ctx, application.PairRequest{Owner: "player", RequestID: "merge", A: chests[0].State.ID, B: chests[1].State.ID})
	if err != nil || scalar(t, f, `SELECT count(*)::text FROM inventory.lifecycle_links WHERE to_id=$1 AND relation='merged_into'`, merged.State.ID) != "2" {
		t.Fatal("chest merge lineage", err)
	}
	for i, condition := range []string{"heavy", "broken"} {
		exec(t, f.db, `INSERT INTO inventory.items(id,owner,definition,condition,origin,status) VALUES($1,'player','item-a',$2,'','available')`, fmt.Sprintf("merge-%d", i), condition)
	}
	f.checkpoint(t)
	kept, err := f.service.MergeItems(ctx, application.PairRequest{Owner: "player", RequestID: "item-merge", A: "merge-0", B: "merge-1"})
	if err != nil || scalar(t, f, `SELECT count(*)::text FROM inventory.lifecycle_links WHERE to_id=$1 AND from_id<>to_id AND relation='merged_into'`, kept.ID) != "1" {
		t.Fatal("item merge lineage", err)
	}
	invalid := kept
	invalid.Status = "undeclared-state"
	if err := f.store.Collection(ctx, func(tx application.CollectionTx) error { return tx.SaveCollectionItem(invalid) }); !errors.Is(err, domain.ErrInvalid) {
		t.Fatal("invalid Go transition accepted", err)
	}

	before = count(t, f.db, "lifecycle_entries")
	exec(t, f.db, `ALTER TABLE inventory.lifecycle_entries ADD CONSTRAINT reject_lifecycle CHECK(kind<>'chest') NOT VALID`)
	if _, err := f.service.Issue(ctx, application.IssueRequest{Owner: "player", RequestID: "must-rollback", Type: "ender", Source: "admin", Count: 1}); err == nil {
		t.Fatal("history failure ignored")
	}
	if count(t, f.db, "chests") != 3 || count(t, f.db, "lifecycle_entries") != before {
		t.Fatal("state or partial history survived failed journal append")
	}
	exec(t, f.db, `ALTER TABLE inventory.lifecycle_entries DROP CONSTRAINT reject_lifecycle`)
	verifyHistory(t, f)
}

func TestLifecycleUpgradeRecordsTruthfulCheckpoints(t *testing.T) {
	f := stackAt(t, 3)
	item := domain.Item{ID: "historical-item"}
	exec(t, f.db, `INSERT INTO inventory.items(id,owner,definition,condition,origin,status) VALUES($1,'player','item-a','heavy','','available')`, item.ID)
	if err := migrations.Up(ctx, f.db); err != nil {
		t.Fatal(err)
	}
	if got := scalar(t, f, `SELECT cause->>'kind' FROM inventory.lifecycle_entries WHERE kind='item' AND id=$1`, item.ID); got != "maintenance_checkpoint" {
		t.Fatal("upgrade invented historical issuance", got)
	}
	before := count(t, f.db, "lifecycle_entries")
	if err := migrations.Up(ctx, f.db); err != nil || count(t, f.db, "lifecycle_entries") != before {
		t.Fatal("migration retry changed checkpoints", err)
	}
	verifyHistory(t, f)
}

func TestLifecycleUpgradeWaitsForInflightWriters(t *testing.T) {
	f := stackAt(t, 3)
	item := domain.Item{ID: "historical-item"}
	exec(t, f.db, `INSERT INTO inventory.items(id,owner,definition,condition,origin,status) VALUES($1,'player','item-a','heavy','','available')`, item.ID)
	tx, err := f.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE inventory.items SET condition='broken' WHERE id=$1`, item.ID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	finished := make(chan struct{})
	migrationContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	go func() { defer close(finished); done <- migrations.Up(migrationContext, f.db) }()
	defer func() { tx.Rollback(); <-finished }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if got := scalar(t, f, `SELECT count(*)::text FROM pg_locks WHERE relation='inventory.items'::regclass AND mode='AccessExclusiveLock' AND NOT granted`); got != "0" {
			break
		}
		select {
		case err := <-done:
			t.Fatal("migration did not wait for the in-flight writer", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("migration lock was not observed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if got := scalar(t, f, `SELECT snapshot->>'condition' FROM inventory.instance_registry WHERE kind='item' AND id=$1`, item.ID); got != "broken" {
		t.Fatal("checkpoint missed the last pre-migration write", got)
	}
	verifyHistory(t, f)
}
