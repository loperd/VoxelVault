package rulebook_test

import (
	"strings"
	"testing"

	"github.com/voxel-vault/api/inventory/domain/rulebook"
	"github.com/voxel-vault/api/inventory/domain/rulebook/rulebooktest"
)

func TestValueResolvesDefaultsPatternsAndRules(t *testing.T) {
	rb := rulebooktest.Build(t, func(def *rulebook.Definition) {
		def.Rules = []rulebook.Rule{
			{ID: "any-ender", When: map[string]rulebook.Condition{"type": {Eq: "ender"}}, Set: map[string]float64{"trait.group.end.chance": .1}},
			{ID: "ender-night", When: map[string]rulebook.Condition{"type": {Eq: "ender"}, "events": {Eq: "end-night"}}, Set: map[string]float64{"trait.group.end.chance": .2}},
			{ID: "night-boost", When: map[string]rulebook.Condition{"events": {Eq: "end-night"}}, Multiply: map[string]float64{"trait.group.end.chance": 3}},
			{ID: "pity", When: map[string]rulebook.Condition{"player.opensSinceRare": {Gte: f(20)}}, Multiply: map[string]float64{"pool.weight.*": 2}},
		}
	})
	ender := rulebook.Situation{"type": "ender"}
	night := rulebook.Situation{"type": "ender", "events": []string{"end-night"}}
	cases := []struct {
		key  string
		s    rulebook.Situation
		want float64
	}{
		{"trait.group.end.chance", rulebook.Situation{}, .03},
		{"trait.group.end.chance", ender, .1},
		{"trait.group.end.chance", night, .6},            // the more specific set, then × 3
		{"trait.moss.weight", rulebook.Situation{}, 1},   // declared by trait.*.weight
		{"trait.void-runes.bonusSlotsPerTier", ender, 1}, // exact beats the pattern
		{"pool.weight.rare", rulebook.Situation{"player.opensSinceRare": 25}, 30},
		{"pool.weight.rare", rulebook.Situation{"player.opensSinceRare": 5}, 15},
	}
	for _, c := range cases {
		if got := rb.Value(c.key, c.s); !near(got, c.want) {
			t.Errorf("%s in %v = %v, want %v", c.key, c.s, got, c.want)
		}
	}
}

func TestValueIsClamped(t *testing.T) {
	rb := rulebooktest.Build(t, func(def *rulebook.Definition) {
		def.Rules = []rulebook.Rule{{ID: "x", Multiply: map[string]float64{"trait.group.damage.chance": 5, "content.size": 1.4}}}
	})
	if got := rb.Value("trait.group.damage.chance", nil); got != 1 {
		t.Errorf("chance = %v, want clamped to 1", got)
	}
	if got := rb.Value("content.size", nil); got != 11 {
		t.Errorf("size = %v, want 8 × 1.4 rounded to 11", got)
	}
}

func TestNewRejectsAnInvalidDefinitionWithEveryProblem(t *testing.T) {
	def := rulebooktest.Definition()
	delete(def.Params, "item.sellRate")
	def.Traits[0].Parts = []string{"wheel"}
	def.Rules = []rulebook.Rule{{ID: "r", When: map[string]rulebook.Condition{"moon": {Eq: "full"}}, Set: map[string]float64{"nope": 1}}}
	_, err := rulebook.New(def)
	if err == nil {
		t.Fatal("invalid definition accepted")
	}
	for _, want := range []string{`"item.sellRate" is not declared`, `unknown part "wheel"`, `unknown situation field "moon"`, `param "nope" is not declared`} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q lacks %q", err, want)
		}
	}
}

func TestTier(t *testing.T) {
	rb := rulebooktest.Build(t)
	for intensity, want := range map[float64]int{.1: 0, .3: 1, .59: 1, .6: 2, .85: 3, 1: 3} {
		if got := rb.Tier("moss", intensity); got != want {
			t.Errorf("tier(%v) = %d, want %d", intensity, got, want)
		}
	}
}

func f(v float64) *float64 { return &v }

func near(a, b float64) bool { return a-b < 1e-9 && b-a < 1e-9 }
