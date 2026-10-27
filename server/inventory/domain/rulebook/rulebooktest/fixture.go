// Package rulebooktest builds small rulebooks for domain tests.
package rulebooktest

import (
	"fmt"
	"testing"

	"github.com/voxel-vault/api/inventory/domain/rulebook"
)

func p(v float64) *float64 { return &v }

func chance(v float64) rulebook.Param { return rulebook.Param{Default: v, Min: p(0), Max: p(1)} }
func count(v float64) rulebook.Param {
	return rulebook.Param{Default: v, Min: p(0), Max: p(5), Integer: true}
}

// Definition is one collection with one twelve-item type (5/3/2/1/1), a damage, an aging, an
// exclusive weather pair and one End trait, and the starting balance of docs/reference/economy.md.
func Definition() rulebook.Definition {
	pool := []rulebook.Item{}
	for i, rarity := range []string{"common", "common", "common", "common", "common", "uncommon", "uncommon", "uncommon", "rare", "rare", "epic", "legendary"} {
		pool = append(pool, rulebook.Item{ID: "item-" + string(rune('a'+i)), Title: rarity, Rarity: rarity})
	}
	return rulebook.Definition{
		Revision:    "test.1",
		Rarities:    []string{"common", "uncommon", "rare", "epic", "legendary"},
		Severities:  []string{"slight", "heavy", "broken"},
		Parts:       []string{"body", "lid", "latch"},
		Tiers:       []float64{.3, .6, .85},
		Collections: []rulebook.Collection{{ID: "the-end", Material: "end-shards"}},
		Types:       []rulebook.ChestType{{ID: "ender", Collection: "the-end", Pool: pool}},
		Groups: []rulebook.Group{
			{ID: "damage", Merge: rulebook.MergeReset}, {ID: "aging", Merge: rulebook.MergeKeep},
			{ID: "weather", Merge: rulebook.MergeKeep}, {ID: "end", Merge: rulebook.MergeKeep},
		},
		Traits: []rulebook.TraitDef{
			{ID: "body-cracks", Group: "damage", Parts: []string{"body"}, Condition: 1},
			{ID: "latch-rust", Group: "damage", Parts: []string{"latch"}, Condition: 1},
			{ID: "moss", Group: "aging", Parts: []string{"body", "lid"}, Condition: 1},
			{ID: "snow", Group: "weather", Parts: []string{"lid"}, Exclusive: "cover"},
			{ID: "frost", Group: "weather", Parts: []string{"lid"}, Exclusive: "cover"},
			{ID: "void-runes", Group: "end", Parts: []string{"body"}, BonusMinRarity: "rare"},
		},
		Params: map[string]rulebook.Param{
			"content.size":                       {Default: 8, Min: p(1), Max: p(32), Integer: true},
			"rarity.threshold":                   {Default: .3, Min: p(.01), Max: p(1)},
			"pool.weight.common":                 {Default: 40, Min: p(0)},
			"pool.weight.uncommon":               {Default: 25, Min: p(0)},
			"pool.weight.rare":                   {Default: 15, Min: p(0)},
			"pool.weight.epic":                   {Default: 8, Min: p(0)},
			"pool.weight.legendary":              {Default: 4, Min: p(0)},
			"trait.intensity.bias":               {Default: 2, Min: p(.01), Max: p(10)},
			"trait.group.damage.chance":          chance(.5),
			"trait.group.aging.chance":           chance(.2),
			"trait.group.weather.chance":         chance(.1),
			"trait.group.end.chance":             chance(.03),
			"trait.group.*.count.min":            count(1),
			"trait.group.*.count.max":            count(1),
			"trait.group.damage.count.max":       count(2),
			"trait.*.weight":                     {Default: 1, Min: p(0)},
			"trait.*.bonusSlotsPerTier":          {Default: 0, Min: p(0), Max: p(8), Integer: true},
			"trait.void-runes.bonusSlotsPerTier": {Default: 1, Min: p(0), Max: p(8), Integer: true},
			"merge.*.keepOne":                    chance(.4),
			"merge.*.keepBoth":                   chance(.85),
			"merge.*.upgrade":                    chance(.25),
			"merge.end.keepOne":                  chance(.2),
			"merge.end.keepBoth":                 chance(.7),
			"landing.damage.chance":              chance(.3),
			"landing.damage.intensity.max":       chance(.4),
			"landing.trait.*.weight":             {Default: 0, Min: p(0)},
			"landing.trait.body-cracks.weight":   {Default: 1, Min: p(0)},
			"landing.trait.latch-rust.weight":    {Default: 1, Min: p(0)},
			"chest.destroy.impact.perWear":       chance(.1),
			"chest.destroy.opening.perWear":      chance(.1),
			"item.damage.perWear":                chance(.6),
			"item.severity.slight.base":          {Default: 1},
			"item.severity.slight.perWear":       {Default: -.7},
			"item.severity.heavy.base":           {Default: 0},
			"item.severity.heavy.perWear":        {Default: .5},
			"item.severity.broken.base":          {Default: 0},
			"item.severity.broken.perWear":       {Default: .2},
			"item.merge.repair":                  chance(.7),
			"item.value.common":                  {Default: 4, Min: p(0)},
			"item.value.uncommon":                {Default: 8, Min: p(0)},
			"item.value.rare":                    {Default: 16, Min: p(0)},
			"item.value.epic":                    {Default: 32, Min: p(0)},
			"item.value.legendary":               {Default: 64, Min: p(0)},
			"item.state.intact.value":            {Default: 1, Min: p(0)},
			"item.state.slight.value":            {Default: .75, Min: p(0)},
			"item.state.heavy.value":             {Default: .5, Min: p(0)},
			"item.state.broken.value":            {Default: .25, Min: p(0)},
			"item.sellRate":                      {Default: 2.5, Min: p(0)},
		},
	}
}

// Build makes a rulebook from a definition, optionally changed first, and fails the test if it
// does not validate.
func Build(t testing.TB, change ...func(*rulebook.Definition)) *rulebook.Rulebook {
	t.Helper()
	def := Definition()
	for _, c := range change {
		c(&def)
	}
	rb, err := rulebook.New(def)
	if err != nil {
		t.Fatal(err)
	}
	return rb
}

// Set adds a rule that sets params in every situation.
func Set(values map[string]float64) func(*rulebook.Definition) {
	return func(def *rulebook.Definition) {
		def.Rules = append(def.Rules, rulebook.Rule{ID: fmt.Sprintf("test-set-%d", len(def.Rules)), Set: values})
	}
}
