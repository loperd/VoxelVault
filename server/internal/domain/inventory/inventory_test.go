package inventory_test

import (
	"errors"
	"testing"

	"github.com/voxel-vault/api/internal/domain/inventory"
	"github.com/voxel-vault/api/internal/domain/wallet"
	"github.com/voxel-vault/api/internal/inventory/domain/rulebook"
	"github.com/voxel-vault/api/internal/inventory/domain/rulebook/rulebooktest"
)

// item-i is rare: base value 16.
func setup(t *testing.T, items ...inventory.Item) (*rulebook.Rulebook, *inventory.Inventory, *wallet.Wallet) {
	t.Helper()
	rb := rulebooktest.Build(t)
	inv := inventory.New("player")
	for _, item := range items {
		if err := inv.Receive(rb, item); err != nil {
			t.Fatal(err)
		}
	}
	return rb, inv, wallet.New("player")
}

func TestRepairCostsTheBaseInMaterialPerStep(t *testing.T) {
	rb, inv, w := setup(t, inventory.Item{ID: "1", Item: "item-i", State: "heavy"})
	if _, err := inv.Repair(rb, w, "1", nil); !errors.Is(err, wallet.ErrInsufficient) {
		t.Fatalf("repair without material: %v", err)
	}
	_ = w.Credit(wallet.Amount{Resource: "end-shards", Value: 40})
	cost, err := inv.Repair(rb, w, "1", nil)
	if err != nil || cost != (wallet.Amount{Resource: "end-shards", Value: 16}) {
		t.Fatalf("cost %+v %v", cost, err)
	}
	if got := inv.Items()[0].State; got != "slight" || w.Balance("end-shards") != 24 {
		t.Fatalf("state %s, balance %d", got, w.Balance("end-shards"))
	}
	_, _ = inv.Repair(rb, w, "1", nil)
	if _, err := inv.Repair(rb, w, "1", nil); !errors.Is(err, inventory.ErrIntact) {
		t.Fatalf("repairing an intact item: %v", err)
	}
}

func TestSalvageAndSell(t *testing.T) {
	rb, inv, w := setup(t, inventory.Item{ID: "1", Item: "item-i", State: "heavy"}, inventory.Item{ID: "2", Item: "item-l", State: "slight"})
	gain, err := inv.Salvage(rb, w, "1", nil)
	if err != nil || gain != (wallet.Amount{Resource: "end-shards", Value: 8}) { // 16 × .5
		t.Fatalf("salvage %+v %v", gain, err)
	}
	gain, err = inv.Sell(rb, w, "2", nil)
	if err != nil || gain != (wallet.Amount{Resource: wallet.Currency, Value: 120}) { // 64 × .75 × 2.5
		t.Fatalf("sell %+v %v", gain, err)
	}
	if len(inv.Items()) != 0 {
		t.Fatal("salvaged and sold items stayed")
	}
}

func TestMergeKeepsTheBetterTwin(t *testing.T) {
	rb, inv, _ := setup(t,
		inventory.Item{ID: "1", Item: "item-i", State: "broken"}, inventory.Item{ID: "2", Item: "item-i", State: "slight"},
		inventory.Item{ID: "3", Item: "item-j", State: "slight"}, inventory.Item{ID: "4", Item: "item-j", State: rulebook.Intact})
	if _, err := inv.Merge(rb, "1", "3", 1, nil); !errors.Is(err, inventory.ErrNotTwins) {
		t.Fatalf("merging different items: %v", err)
	}
	if _, err := inv.Merge(rb, "3", "4", 1, nil); !errors.Is(err, inventory.ErrIntact) {
		t.Fatalf("merging with an intact item: %v", err)
	}
	kept, err := inv.Merge(rb, "1", "2", 1, nil)
	if err != nil || kept.ID != "2" || (kept.State != "slight" && kept.State != rulebook.Intact) {
		t.Fatalf("kept %+v %v", kept, err)
	}
	if len(inv.Items()) != 3 {
		t.Fatal("the worse twin stayed")
	}
}

func TestQuotedMergeIsTheMergeTheServerDoes(t *testing.T) {
	// Only a heavy item is ever mended: the chance is the kept twin's, not the quoted one's.
	rb := rulebooktest.Build(t, rulebooktest.Set(map[string]float64{"item.merge.repair": 0}), func(def *rulebook.Definition) {
		def.Rules = append(def.Rules, rulebook.Rule{ID: "heavy-mends", Priority: 1,
			When: map[string]rulebook.Condition{"item.state": {Eq: "heavy"}}, Set: map[string]float64{"item.merge.repair": 1}})
	})
	inv := inventory.New("p")
	for _, item := range []inventory.Item{{ID: "1", Item: "item-i", State: "broken"}, {ID: "2", Item: "item-i", State: "slight"},
		{ID: "3", Item: "item-i", State: "heavy"}, {ID: "4", Item: "item-i", State: rulebook.Intact}} {
		if err := inv.Receive(rb, item); err != nil {
			t.Fatal(err)
		}
	}
	if offers, _ := inv.Quote(rb, "2", nil); offers.MergeWith != "1" || offers.MergeRepair != 0 {
		t.Fatalf("the slight item pairs with the broken one and stays slight: %+v", offers)
	}
	if offers, _ := inv.Quote(rb, "4", nil); offers.MergeWith != "" {
		t.Fatalf("an intact item has no merge: %+v", offers)
	}
	offers, err := inv.Quote(rb, "1", nil)
	if err != nil || offers.MergeWith != "3" || offers.MergeRepair != 1 {
		t.Fatalf("the broken item pairs with the heavy one, which stays and surely mends: %+v %v", offers, err)
	}
	if kept, err := inv.Merge(rb, "1", offers.MergeWith, 7, nil); err != nil || kept.ID != "3" || kept.State != "slight" {
		t.Fatalf("quoted a sure mend, got %+v %v", kept, err)
	}
}

func TestReceiveRejectsUnknownItemsAndDuplicates(t *testing.T) {
	rb, inv, _ := setup(t, inventory.Item{ID: "1", Item: "item-a", State: rulebook.Intact})
	if err := inv.Receive(rb, inventory.Item{ID: "2", Item: "nope", State: rulebook.Intact}); !errors.Is(err, inventory.ErrUnknownItem) {
		t.Fatalf("unknown item: %v", err)
	}
	if err := inv.Receive(rb, inventory.Item{ID: "1", Item: "item-a", State: rulebook.Intact}); !errors.Is(err, inventory.ErrDuplicate) {
		t.Fatalf("duplicate: %v", err)
	}
}

func TestQuoteIsWhatTheActionsThenDo(t *testing.T) {
	rb, inv, w := setup(t, inventory.Item{ID: "1", Item: "item-i", State: "heavy"}, inventory.Item{ID: "2", Item: "item-i", State: "intact"})
	intact, err := inv.Quote(rb, "2", nil)
	if err != nil || intact.Repair != nil {
		t.Fatalf("an intact item has no repair: %+v %v", intact, err)
	}
	offers, err := inv.Quote(rb, "1", nil)
	if err != nil || offers.Repair == nil {
		t.Fatalf("quote %+v %v", offers, err)
	}
	_ = w.Credit(wallet.Amount{Resource: "end-shards", Value: 100})
	if cost, _ := inv.Repair(rb, w, "1", nil); cost != *offers.Repair {
		t.Fatalf("repair cost %+v, quoted %+v", cost, *offers.Repair)
	}
	offers, _ = inv.Quote(rb, "1", nil)
	if gain, _ := inv.Sell(rb, w, "1", nil); gain != offers.Sell {
		t.Fatalf("sold for %+v, quoted %+v", gain, offers.Sell)
	}
	offers, _ = inv.Quote(rb, "2", nil)
	if gain, _ := inv.Salvage(rb, w, "2", nil); gain != offers.Salvage {
		t.Fatalf("salvaged for %+v, quoted %+v", gain, offers.Salvage)
	}
	if _, err := inv.Quote(rb, "2", nil); !errors.Is(err, inventory.ErrUnknownItem) {
		t.Fatalf("quote of a gone item: %v", err)
	}
}
