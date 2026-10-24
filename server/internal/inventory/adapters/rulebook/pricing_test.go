package rulebook_test

import (
	adapter "github.com/voxel-vault/api/internal/inventory/adapters/rulebook"
	"github.com/voxel-vault/api/internal/inventory/domain"
	rules "github.com/voxel-vault/api/internal/inventory/domain/rulebook"
	"github.com/voxel-vault/api/internal/inventory/domain/rulebook/rulebooktest"
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
