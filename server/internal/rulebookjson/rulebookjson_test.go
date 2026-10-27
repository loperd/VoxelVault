package rulebookjson_test

import (
	"strings"
	"testing"
	"time"

	"github.com/voxel-vault/api/internal/rulebookjson"
	"github.com/voxel-vault/api/inventory/domain/rulebook"
)

func TestTheShippedRulebookLoads(t *testing.T) {
	rb, err := rulebookjson.Load("../../config/economy.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := rb.Type("ender"); !ok {
		t.Fatal("ender type missing")
	}
	night := rulebook.Situation{"type": "ender", "collection": "the-end", "events": rb.ActiveEvents(time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC))}
	if got := rb.Value("trait.group.end.chance", night); got < .089 || got > .091 {
		t.Errorf("End chance on end-night = %v, want 0.09", got)
	}
	if got := rb.Value("trait.group.end.chance", rulebook.Situation{"type": "traveler"}); got != 0 {
		t.Errorf("End chance for traveler = %v, want 0", got)
	}
}

func TestConditionsReadBareValuesAndObjects(t *testing.T) {
	data := strings.Replace(minimal, `"rules": []`, `"rules": [
		{"id": "a", "when": {"type": "ender"}, "set": {"content.size": 4}},
		{"id": "b", "when": {"type": "ender", "player.opens": {"gte": 10}}, "set": {"content.size": 6}}
	]`, 1)
	rb, err := rulebookjson.Parse([]byte(data))
	if err != nil {
		t.Fatal(err)
	}
	if got := rb.Value("content.size", rulebook.Situation{"type": "ender", "player.opens": 3.0}); got != 4 {
		t.Errorf("size = %v, want 4", got)
	}
	if got := rb.Value("content.size", rulebook.Situation{"type": "ender", "player.opens": 12.0}); got != 6 {
		t.Errorf("size = %v, want 6", got)
	}
}

func TestUnknownFieldsAreRejected(t *testing.T) {
	for _, data := range []string{
		strings.Replace(minimal, `"revision"`, `"revison": "x", "revision"`, 1),
		strings.Replace(minimal, `"rules": []`, `"rules": [{"id": "a", "when": {"type": {"equals": "ender"}}, "set": {"content.size": 4}}]`, 1),
	} {
		if _, err := rulebookjson.Parse([]byte(data)); err == nil {
			t.Errorf("accepted %s", data)
		}
	}
}

// minimal is the smallest valid rulebook: one type of one item, no traits.
const minimal = `{
	"revision": "t.1", "rarities": ["common"], "severities": ["broken"], "parts": ["body"], "tiers": [0.5],
	"events": [], "collections": [{"id": "c", "material": "m"}],
	"types": [{"id": "ender", "collection": "c", "pool": [{"id": "i", "title": "I", "rarity": "common", "glyph": "eye"}]}],
	"groups": [], "traits": [],
	"params": {
		"content.size": {"default": 1, "min": 1, "integer": true}, "rarity.threshold": {"default": 0.3},
		"trait.intensity.bias": {"default": 2}, "landing.damage.chance": {"default": 0}, "landing.damage.intensity.max": {"default": 0},
		"chest.destroy.impact.perWear": {"default": 0}, "chest.destroy.opening.perWear": {"default": 0},
		"item.damage.perWear": {"default": 0}, "item.merge.repair": {"default": 0}, "item.sellRate": {"default": 1},
		"item.state.intact.value": {"default": 1}, "pool.weight.common": {"default": 1}, "item.value.common": {"default": 1},
		"item.severity.broken.base": {"default": 1}, "item.severity.broken.perWear": {"default": 0}, "item.state.broken.value": {"default": 0}
	},
	"rules": []
}`
