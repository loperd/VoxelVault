package economycutover_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/voxel-vault/api/internal/economycutover"
	"github.com/voxel-vault/api/internal/economycutover/adapters/legacy"
	ilocal "github.com/voxel-vault/api/internal/inventory/adapters/inbound/local"
	ipg "github.com/voxel-vault/api/internal/inventory/adapters/postgres"
	inv "github.com/voxel-vault/api/internal/inventory/application"
	iv1 "github.com/voxel-vault/api/internal/inventory/contracts/v1"
	"github.com/voxel-vault/api/internal/inventory/domain"
	"github.com/voxel-vault/api/internal/inventory/domain/chest"
	"github.com/voxel-vault/api/internal/inventory/domain/rulebook"
	"github.com/voxel-vault/api/internal/inventory/domain/rulebook/rulebooktest"
)

func chestClient(f *fixture) ilocal.ChestsOpeningClient {
	return ilocal.ChestsOpeningClient{Service: inv.ChestsOpeningService{Authorizer: allowInventory{}, Store: ipg.New(f.idb)}}
}
func validArchive(t *testing.T, f *fixture) {
	t.Helper()
	exec(t, f.source, `UPDATE chest_instances SET case_id='ender',origin_source='admin',contents='[{"Item":"item-a","Weight":1}]'`)
	exec(t, f.source, `UPDATE inventory_items SET origin='' WHERE origin='chest-a'`)
}

func TestChestImportPreservesStateAndStarterMarkers(t *testing.T) {
	f := setup(t)
	validArchive(t, f)
	exec(t, f.source, `UPDATE economy_owners SET starter_granted_at=now() WHERE id='alice'`)
	s := f.freeze(t)
	f.apply(t, s)
	r, err := legacy.ChestOpening(s)
	if err != nil {
		t.Fatal(err)
	}
	c := chestClient(f)
	if err = c.ImportChests(ctx, r); err != nil {
		t.Fatal(err)
	}
	if err = c.ImportChests(ctx, r); err != nil {
		t.Fatal("replay", err)
	}
	if count(t, f.idb, "inventory.chests") != 1 || count(t, f.idb, "inventory.owners") != 2 {
		t.Fatal("duplicate chest baseline")
	}
	var actual domain.StoredChest
	var raw []byte
	if err = f.idb.QueryRow(`SELECT body FROM inventory.chests`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &actual); err != nil {
		t.Fatal(err)
	}
	if actual.State.Seed != 9007199254740993 || actual.State.Type != "ender" || actual.State.Condition != .75 || len(actual.State.Contents) != 1 {
		t.Fatal("chest metadata lost", actual)
	}
	rb := rulebooktest.Build(t)
	service := inv.CollectionService{Authorizer: allowInventory{}, StarterPolicy: func([]inv.Grant) bool { return true }, Store: ipg.New(f.idb), Rulebook: func() *rulebook.Rulebook { return rb }, Clock: time.Now, Seed: func() (uint64, error) { return 5, nil }}
	if err = service.GrantStarter(ctx, "alice", []inv.Grant{{Type: "ender", Count: 1}}); err != nil || count(t, f.idb, "inventory.chests") != 1 {
		t.Fatal("migrated owner received starters twice", err)
	}
	if err = service.GrantStarter(ctx, "bob", []inv.Grant{{Type: "ender", Count: 1}}); err != nil || count(t, f.idb, "inventory.chests") != 2 {
		t.Fatal("ungranted owner lost starter entitlement", err)
	}
	if err = c.ImportChests(ctx, r); err == nil {
		t.Fatal("post-import starter activity accepted as baseline")
	}
}

func TestLegacyOpenedChestDoesNotResurrectSoldReward(t *testing.T) {
	f := setup(t)
	validArchive(t, f)
	exec(t, f.source, `DELETE FROM inventory_items WHERE id='item-a'; UPDATE chest_instances SET revision='',status='opened',session_id='old-session',reward_id='item-a',drop_state='',opened_at=now()`)
	s := f.freeze(t)
	f.apply(t, s)
	r, err := legacy.ChestOpening(s)
	if err != nil {
		t.Fatal(err)
	}
	if r.Chests[0].Reward != nil || r.Chests[0].Drop.Condition != "intact" {
		t.Fatal("legacy receipt translation", r.Chests[0])
	}
	if err = chestClient(f).ImportChests(ctx, r); err != nil {
		t.Fatal(err)
	}
	rb := rulebooktest.Build(t)
	service := inv.CollectionService{Authorizer: allowInventory{}, StarterPolicy: func([]inv.Grant) bool { return true }, Store: ipg.New(f.idb), Rulebook: func() *rulebook.Rulebook { return rb }, Clock: time.Now, Seed: func() (uint64, error) { return 7, nil }}
	cs, err := service.Chests(ctx, "alice")
	if err != nil || len(cs) != 1 || cs[0].State.Legacy() {
		t.Fatal(cs, err)
	}
	before := count(t, f.idb, "inventory.items")
	opened, err := service.Open(ctx, "alice", "chest-a", "old-session")
	if err != nil || opened.Reward != nil || opened.State.Drop == nil {
		t.Fatal(opened, err)
	}
	if count(t, f.idb, "inventory.items") != before {
		t.Fatal("sold historical reward was minted during reconstruction")
	}
}

func TestExistingRewardReceiptDoesNotOverwriteRepairedItem(t *testing.T) {
	f := setup(t)
	validArchive(t, f)
	exec(t, f.source, `UPDATE chest_instances SET status='opened',session_id='old-session',reward_id='compass',drop_state='broken',opened_at=now()`)
	exec(t, f.source, `UPDATE inventory_items SET origin='chest-a' WHERE id='item-a'`)
	s := f.freeze(t)
	f.apply(t, s)
	r, err := legacy.ChestOpening(s)
	if err != nil {
		t.Fatal(err)
	}
	if r.Chests[0].Reward == nil || r.Chests[0].Reward.Condition != "broken" {
		t.Fatal(r.Chests[0])
	}
	if err = chestClient(f).ImportChests(ctx, r); err != nil {
		t.Fatal(err)
	}
	items, err := ipg.New(f.idb).Items(ctx, "alice")
	if err != nil || len(items) != 1 || items[0].Condition != "heavy" {
		t.Fatal("historical receipt overwrote current condition", items, err)
	}
}

type lostChests struct{ next iv1.ChestsOpeningClient }

func (c lostChests) ImportChests(ctx context.Context, in iv1.ChestsOpening) error {
	if err := c.next.ImportChests(ctx, in); err != nil {
		return err
	}
	return errors.New("lost committed chest import reply")
}

func TestChestImportRequiresMatchingItemsAndRecoversAfterCommit(t *testing.T) {
	f := setup(t)
	validArchive(t, f)
	s := f.freeze(t)
	r, err := legacy.ChestOpening(s)
	if err != nil {
		t.Fatal(err)
	}
	client := chestClient(f)
	if err = client.ImportChests(ctx, r); err == nil || count(t, f.idb, "inventory.chests") != 0 {
		t.Fatal("missing item baseline accepted")
	}
	f.apply(t, s)
	if err = (lostChests{client}).ImportChests(ctx, r); err == nil || count(t, f.idb, "inventory.chests") != 1 {
		t.Fatal("missing commit", err)
	}
	if err = chestClient(f).ImportChests(ctx, r); err != nil {
		t.Fatal(err)
	}
	r.Owners[0].ID = "other-owner"
	if err = client.ImportChests(ctx, r); err == nil {
		t.Fatal("changed chest baseline accepted")
	}
}

func TestChestImportRollsBackAndRejectsInvalidArchives(t *testing.T) {
	f := setup(t)
	validArchive(t, f)
	s := f.freeze(t)
	f.apply(t, s)
	r, err := legacy.ChestOpening(s)
	if err != nil {
		t.Fatal(err)
	}
	client := chestClient(f)
	bad := r
	bad.Chests = append([]iv1.OpeningChest(nil), r.Chests...)
	bad.Chests[0].Status = "unknown"
	if err = client.ImportChests(ctx, bad); err == nil || count(t, f.idb, "inventory.owners") != 0 {
		t.Fatal("invalid chest mutated target")
	}
	exec(t, f.idb, `ALTER TABLE inventory.chests ADD CONSTRAINT reject_import CHECK(false) NOT VALID`)
	if err = client.ImportChests(ctx, r); err == nil {
		t.Fatal("failed chest import accepted")
	}
	if count(t, f.idb, "inventory.owners") != 0 || count(t, f.idb, "inventory.chest_baseline") != 0 {
		t.Fatal("chest import partially committed")
	}
	exec(t, f.idb, `ALTER TABLE inventory.chests DROP CONSTRAINT reject_import`)
	if err = client.ImportChests(ctx, r); err != nil {
		t.Fatal(err)
	}
}

func TestChestArchiveRejectsOrphanAndAmbiguousRewards(t *testing.T) {
	f := setup(t)
	// The original fixture deliberately has an item pointing to an unopened chest.
	s := f.freeze(t)
	if _, err := legacy.ChestOpening(s); err == nil {
		t.Fatal("unrecorded old reward could be duplicated after cutover")
	}
	// A duplicate origin is ambiguous even if both instance IDs and owners are valid.
	s.Items = append(s.Items, iv1.OpeningItem{ID: "another-item", Owner: "alice", Definition: "compass", Condition: "intact", Origin: "chest-a"})
	if err := s.Seal(); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.ChestOpening(s); err == nil {
		t.Fatal("ambiguous reward accepted")
	}
}

func TestExportPreflightRejectsInvalidChestWithoutFreezingWrites(t *testing.T) {
	f := setup(t)
	validator := ilocal.ChestsOpeningClient{}
	source := legacy.Source{DB: f.source, Preflight: func(s economycutover.Snapshot) error {
		r, err := legacy.ChestOpening(s)
		if err != nil {
			return err
		}
		return validator.ValidateChestsOpening(ctx, r)
	}}
	if _, err := source.FreezeAndExport(ctx, "preflight"); err == nil {
		t.Fatal("unimportable chest snapshot froze source")
	}
	var frozen bool
	if err := f.source.QueryRow(`SELECT frozen FROM legacy_economy_cutover.snapshot`).Scan(&frozen); err != nil || frozen {
		t.Fatal(frozen, err)
	}
	validArchive(t, f)
	if _, err := source.FreezeAndExport(ctx, "preflight"); err != nil {
		t.Fatal(err)
	}
}

func TestPublishedCollectionAdapterKeepsScalarViews(t *testing.T) {
	f := setup(t)
	rb := rulebooktest.Build(t, rulebooktest.Set(map[string]float64{"chest.destroy.impact.perWear": 0, "chest.destroy.opening.perWear": 0}))
	client := ilocal.CollectionClient{Service: inv.CollectionService{Authorizer: allowInventory{}, StarterPolicy: func([]inv.Grant) bool { return true }, Store: ipg.New(f.idb), Rulebook: func() *rulebook.Rulebook { return rb }, Clock: time.Now, Seed: func() (uint64, error) { return 9007199254740993, nil }}}
	cs, err := client.Issue(ctx, iv1.IssueRequest{Owner: "new-player", RequestID: "issue", Type: "ender", Source: "admin", Count: 1})
	if err != nil || len(cs) != 1 || cs[0].Seed != "9007199254740993" {
		t.Fatal(cs, err)
	}
	id := cs[0].ID
	if _, err = client.Claim(ctx, "other", id, "session"); err == nil {
		t.Fatal("foreign owner accepted")
	} else {
		var public *iv1.Error
		if !errors.As(err, &public) || public.Code != iv1.NotFound {
			t.Fatal("domain error leaked", err)
		}
	}
	if _, err = client.Claim(ctx, "new-player", id, "session"); err != nil {
		t.Fatal(err)
	}
	first, err := client.Open(ctx, "new-player", id, "session")
	if err != nil || first.Reward == nil {
		t.Fatal(first, err)
	}
	again, err := client.Open(ctx, "new-player", id, "session")
	if err != nil || !reflect.DeepEqual(first, again) {
		t.Fatal("published retry changed", err)
	}
	items, err := client.Items(ctx, "new-player")
	if err != nil || len(items) != 1 || items[0].Status != domain.Available {
		t.Fatal(items, err)
	}
	if first.Status != string(chest.Opened) {
		t.Fatal(first)
	}
}
