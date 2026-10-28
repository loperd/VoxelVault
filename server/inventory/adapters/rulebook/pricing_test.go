package rulebook_test

import (
	adapter "github.com/voxel-vault/api/inventory/adapters/rulebook"
	"github.com/voxel-vault/api/inventory/domain"
	rules "github.com/voxel-vault/api/inventory/domain/rulebook"
	"github.com/voxel-vault/api/inventory/domain/rulebook/rulebooktest"
	"testing"
	"time"
)

func TestPricingTranslatesCurrentServerRules(t *testing.T) {
	rb := rulebooktest.Build(t)
	p := adapter.Pricing{Current: func() *rules.Rulebook { return rb }, Clock: func() time.Time { return time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC) }}
	item := domain.Item{ID: "owned", Owner: "player", Definition: "item-a", Condition: "heavy", Origin: "chest", Status: domain.Available}
	for _, tc := range []struct {
		action domain.Action
		asset  string
		units  int64
	}{{domain.Repair, "end-shards", 4}, {domain.Sell, "currency", 5}, {domain.Salvage, "end-shards", 2}} {
		quote, err := p.Quote(item, tc.action)
		if err != nil || quote.Asset != tc.asset || quote.Units != tc.units || quote.Revision != "test.1" {
			t.Fatal(tc, quote, err)
		}
	}
}

func TestOffersPriceEveryActionAndPairTwins(t *testing.T) {
	rb := rulebooktest.Build(t)
	p := adapter.Pricing{Current: func() *rules.Rulebook { return rb }, Clock: func() time.Time { return time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC) }}
	item := func(id, status string) domain.Item {
		return domain.Item{ID: id, Owner: "player", Definition: "item-a", Condition: "heavy", Origin: "chest", Status: status}
	}
	offers := p.Offers([]domain.Item{item("a", domain.Available), item("b", domain.Available), item("c", domain.Locked)})
	o := offers["a"]
	if o.MergeWith != "b" || o.Sell.Asset != "currency" || o.Sell.Units != 5 || o.Salvage.Units != 2 || o.Repair == nil || o.Repair.Units != 4 {
		t.Fatal(o)
	}
	if _, ok := offers["c"]; ok {
		t.Fatal("a locked item is not offered")
	}
}
