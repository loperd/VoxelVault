package chest_test

import (
	"errors"
	"math"
	"reflect"
	"testing"

	"github.com/voxel-vault/api/inventory/domain/chest"
	"github.com/voxel-vault/api/inventory/domain/rulebook"
	"github.com/voxel-vault/api/inventory/domain/rulebook/rulebooktest"
)

func issue(t *testing.T, rb *rulebook.Rulebook, id string, seed uint64) *chest.Chest {
	t.Helper()
	c, err := chest.Issue(rb, chest.IssueRequest{ID: id, Owner: "player", Type: "ender", Source: "admin", Seed: seed})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestMergeDropsTraitsRemovedFromCurrentRulebook(t *testing.T) {
	rb := rulebooktest.Build(t)
	a, b := issue(t, rb, "a", 1), issue(t, rb, "b", 2)
	s := a.State()
	s.Traits = append(s.Traits, chest.Trait{ID: "removed-trait", Intensity: .5})
	a = chest.Restore(s)
	if _, err := chest.Odds(rb, a, b, nil); err != nil {
		t.Fatal(err)
	}
	c, err := chest.Merge(rb, a, b, chest.MergeRequest{ID: "merged", Seed: 3})
	if err != nil {
		t.Fatal(err)
	}
	for _, trait := range c.State().Traits {
		if trait.ID == "removed-trait" {
			t.Fatal("unknown trait survived merge")
		}
	}
}

func TestIssueIsDeterministicAndHoldsDistinctPoolItems(t *testing.T) {
	rb := rulebooktest.Build(t)
	for seed := range uint64(200) {
		a, b := issue(t, rb, "c", seed).State(), issue(t, rb, "c", seed).State()
		if !reflect.DeepEqual(a, b) {
			t.Fatalf("seed %d issued two different chests", seed)
		}
		if len(a.Contents) != 8 {
			t.Fatalf("seed %d: %d items, want 8", seed, len(a.Contents))
		}
		seen := map[string]bool{}
		for _, slot := range a.Contents {
			if _, _, ok := rb.Item(slot.Item); !ok || seen[slot.Item] {
				t.Fatalf("seed %d: bad or repeated item %q", seed, slot.Item)
			}
			seen[slot.Item] = true
		}
		if a.Revision != "test.1" || a.Status != chest.Available || a.Rarity == "" {
			t.Fatalf("seed %d: %+v", seed, a)
		}
		snow, frost := false, false
		for _, trait := range a.Traits {
			snow, frost = snow || trait.ID == "snow", frost || trait.ID == "frost"
			if trait.Intensity <= 0 || trait.Intensity > 1 {
				t.Fatalf("seed %d: intensity %v", seed, trait.Intensity)
			}
		}
		if snow && frost {
			t.Fatalf("seed %d: exclusive traits together", seed)
		}
	}
}

func TestIssueFollowsGroupChances(t *testing.T) {
	rb := rulebooktest.Build(t)
	damaged := 0
	const runs = 4000
	for seed := range uint64(runs) {
		for _, trait := range issue(t, rb, "c", seed).State().Traits {
			if trait.ID == "body-cracks" || trait.ID == "latch-rust" {
				damaged++
				break
			}
		}
	}
	if share := float64(damaged) / runs; math.Abs(share-.5) > .03 {
		t.Errorf("damaged share %.3f, want about 0.5", share)
	}
}

func TestRulesCanKeepAStarterIntact(t *testing.T) {
	rb := rulebooktest.Build(t, func(def *rulebook.Definition) {
		def.Rules = append(def.Rules, rulebook.Rule{ID: "starter", When: map[string]rulebook.Condition{"source": {Eq: "starter"}},
			Set: map[string]float64{"trait.group.damage.chance": 0, "trait.group.aging.chance": 0}})
	})
	for seed := range uint64(300) {
		c, _ := chest.Issue(rb, chest.IssueRequest{ID: "c", Type: "ender", Source: "starter", Seed: seed})
		if got := c.State().Condition; got != 1 {
			t.Fatalf("seed %d: starter condition %v", seed, got)
		}
	}
}

func TestEndTierBringsRareItems(t *testing.T) {
	// Every chest gets void-runes near full intensity (tier III) and no other traits.
	rb := rulebooktest.Build(t, rulebooktest.Set(map[string]float64{
		"trait.group.end.chance": 1, "trait.group.damage.chance": 0, "trait.group.aging.chance": 0,
		"trait.group.weather.chance": 0, "trait.intensity.bias": .01,
	}))
	for seed := range uint64(300) {
		s := issue(t, rb, "c", seed).State()
		rare := 0
		for _, slot := range s.Contents {
			if item, _, _ := rb.Item(slot.Item); rb.RarityRank(item.Rarity) >= rb.RarityRank("rare") {
				rare++
			}
		}
		if rare < 3 || rb.RarityRank(s.Rarity) < rb.RarityRank("rare") {
			t.Fatalf("seed %d: %d rare+ items, rarity %s", seed, rare, s.Rarity)
		}
	}
}

func TestRarityByShareOfItemsAtOrAbove(t *testing.T) {
	rb := rulebooktest.Build(t)
	slots := func(ids ...string) []chest.Slot {
		var out []chest.Slot
		for _, id := range ids {
			out = append(out, chest.Slot{Item: id, Weight: 1})
		}
		return out
	}
	// a–e common, f–h uncommon, i–j rare, k epic, l legendary.
	cases := map[string][]chest.Slot{
		"common":   slots("a", "b", "c", "d", "e", "f", "g"),      // 2 of 7 uncommon+: under 30%
		"uncommon": slots("a", "b", "c", "d", "e", "f", "g", "h"), // 3 of 8 uncommon+
		"rare":     slots("a", "b", "c", "d", "e", "i", "j", "k"), // 3 of 8 rare+, 1 epic+
		"epic":     slots("a", "b", "c", "k", "l"),                // 2 of 5 epic+: "or above" counts the legendary
	}
	for want, contents := range cases {
		for i := range contents {
			contents[i].Item = "item-" + contents[i].Item
		}
		if got := chest.Rarity(rb, contents, .3); got != want {
			t.Errorf("%v: rarity %s, want %s", contents, got, want)
		}
	}
}

func TestConditionIsTheWorstPart(t *testing.T) {
	rb := rulebooktest.Build(t)
	traits := []chest.Trait{{ID: "body-cracks", Intensity: .5}, {ID: "moss", Intensity: .2}, {ID: "latch-rust", Intensity: .3}, {ID: "snow", Intensity: 1}}
	if got := chest.Condition(rb, traits); math.Abs(got-.3) > 1e-9 {
		t.Errorf("condition %v, want 0.3 (body 70%% worn)", got)
	}
}

func TestClaimAndOpen(t *testing.T) {
	rb := rulebooktest.Build(t, rulebooktest.Set(map[string]float64{"chest.destroy.impact.perWear": 0, "chest.destroy.opening.perWear": 0}))
	c := issue(t, rb, "c", 7)
	if _, err := c.Open(rb, nil, "s1"); !errors.Is(err, chest.ErrNotOpening) {
		t.Fatalf("open before claim: %v", err)
	}
	if _, err := c.Claim(rb, nil, "s1"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Claim(rb, nil, "s2"); !errors.Is(err, chest.ErrUnavailable) {
		t.Fatalf("second claim: %v", err)
	}
	if _, err := c.Open(rb, nil, "s2"); !errors.Is(err, chest.ErrWrongSession) {
		t.Fatalf("open by another session: %v", err)
	}
	out, err := c.Open(rb, nil, "s1")
	if err != nil || out.Drop == nil {
		t.Fatalf("open: %+v %v", out, err)
	}
	s := c.State()
	found := false
	for _, slot := range s.Contents {
		found = found || slot.Item == out.Drop.Item
	}
	if !found || s.Status != chest.Opened {
		t.Fatalf("drop %q not from the chest's own set, status %s", out.Drop.Item, s.Status)
	}
	if _, err := c.Open(rb, nil, "s1"); !errors.Is(err, chest.ErrNotOpening) {
		t.Fatalf("second open: %v", err)
	}
}

func TestWornChestsDropDamagedItemsAndBreak(t *testing.T) {
	rb := rulebooktest.Build(t, rulebooktest.Set(map[string]float64{"landing.damage.chance": 0}))
	ruined := []chest.Trait{{ID: "body-cracks", Intensity: 1}}
	damaged, destroyed := 0, 0
	const runs = 4000
	for seed := range uint64(runs) {
		s := issue(t, rb, "c", seed).State()
		s.Traits, s.Condition = ruined, 0
		c := chest.Restore(s)
		landing, _ := c.Claim(rb, nil, "s")
		if landing.Destroyed {
			destroyed++
			continue
		}
		out, _ := c.Open(rb, nil, "s")
		if out.Destroyed {
			destroyed++
		} else if out.Drop.State != rulebook.Intact {
			damaged++
		}
	}
	// Destroyed: 10% at impact, then 10% of the rest at opening; damaged: 60% of the drops.
	if share := float64(destroyed) / runs; math.Abs(share-.19) > .03 {
		t.Errorf("destroyed %.3f, want about 0.19", share)
	}
	if share := float64(damaged) / float64(runs-destroyed); math.Abs(share-.6) > .03 {
		t.Errorf("damaged drops %.3f, want about 0.6", share)
	}
}

func TestLandingDamagesFromTheRulebook(t *testing.T) {
	rb := rulebooktest.Build(t, rulebooktest.Set(map[string]float64{
		"landing.damage.chance": 1, "trait.group.damage.chance": 0, "trait.group.aging.chance": 0,
		"chest.destroy.impact.perWear": 0,
	}))
	c := issue(t, rb, "c", 3)
	landing, err := c.Claim(rb, nil, "s")
	if err != nil || landing.Damage == nil {
		t.Fatalf("landing %+v %v", landing, err)
	}
	if id := landing.Damage.ID; id != "body-cracks" && id != "latch-rust" {
		t.Fatalf("landing added %q, only weighted traits may come", id)
	}
	if got := c.State().Condition; got >= 1 {
		t.Fatalf("condition %v after a damaging landing", got)
	}
}

func TestMerge(t *testing.T) {
	rb := rulebooktest.Build(t)
	a, b := issue(t, rb, "a", 1), issue(t, rb, "b", 2)
	other, _ := chest.Issue(rb, chest.IssueRequest{ID: "x", Owner: "someone", Type: "ender", Seed: 3})
	if _, err := chest.Merge(rb, a, other, chest.MergeRequest{ID: "m"}); !errors.Is(err, chest.ErrMismatch) {
		t.Fatalf("merge across owners: %v", err)
	}
	if _, err := chest.Merge(rb, a, a, chest.MergeRequest{ID: "m"}); !errors.Is(err, chest.ErrMismatch) {
		t.Fatalf("merge with itself: %v", err)
	}
	sa, sb := a.State(), b.State()
	sa.Traits = []chest.Trait{{ID: "body-cracks", Intensity: .9}, {ID: "moss", Intensity: .5}, {ID: "snow", Intensity: .4}}
	sb.Traits = []chest.Trait{{ID: "moss", Intensity: .7}, {ID: "frost", Intensity: .8}}
	a, b = chest.Restore(sa), chest.Restore(sb)
	first, err := chest.Merge(rb, a, b, chest.MergeRequest{ID: "m", Seed: 9})
	if err != nil {
		t.Fatal(err)
	}
	m := first.State()
	if a.State().Status != chest.Merged || b.State().Status != chest.Merged {
		t.Fatal("sources not spent")
	}
	if !reflect.DeepEqual(m.Origin.Parents, []string{"a", "b"}) || m.Status != chest.Available || len(m.Contents) != 8 {
		t.Fatalf("merged %+v", m)
	}
	for _, trait := range m.Traits {
		if trait.ID == "body-cracks" {
			t.Fatal("damage survived a merge")
		}
	}
	if _, err := chest.Merge(rb, a, b, chest.MergeRequest{ID: "m2"}); !errors.Is(err, chest.ErrUnavailable) {
		t.Fatalf("merging spent chests: %v", err)
	}
	again, _ := chest.Merge(rb, chest.Restore(sa), chest.Restore(sb), chest.MergeRequest{ID: "m", Seed: 9})
	if !reflect.DeepEqual(again.State(), m) {
		t.Fatal("same merge seed, different result")
	}
}

func TestOddsAreWhatMergesThenDo(t *testing.T) {
	rb := rulebooktest.Build(t)
	sa, sb := issue(t, rb, "a", 1).State(), issue(t, rb, "b", 2).State()
	// Snow and frost are exclusive: snow stays only when frost, more intense, is gone.
	sa.Traits = []chest.Trait{{ID: "body-cracks", Intensity: .9}, {ID: "moss", Intensity: .5}, {ID: "void-runes", Intensity: .4}, {ID: "snow", Intensity: .2}}
	sb.Traits = []chest.Trait{{ID: "moss", Intensity: .7}, {ID: "frost", Intensity: .5}}
	odds, err := chest.Odds(rb, chest.Restore(sa), chest.Restore(sb), nil)
	if err != nil {
		t.Fatal(err)
	}
	want := []chest.TraitOdds{{ID: "body-cracks"}, {ID: "moss", Keep: .85, Upgrade: .85 * .25}, {ID: "void-runes", Keep: .2}, {ID: "snow", Keep: .4 * .6}, {ID: "frost", Keep: .4}}
	for i, o := range odds.Traits {
		if o.ID != want[i].ID || math.Abs(o.Keep-want[i].Keep) > 1e-9 || math.Abs(o.Upgrade-want[i].Upgrade) > 1e-9 {
			t.Fatalf("odds %+v, want %+v", odds.Traits, want)
		}
	}
	if len(odds.Traits) != len(want) || odds.Size != 8 || odds.Contents < 8 || odds.ItemKeep != 8/float64(odds.Contents) {
		t.Fatalf("odds %+v", odds)
	}
	const runs = 4000
	kept, upgraded := map[string]int{}, 0
	for seed := range uint64(runs) {
		m, err := chest.Merge(rb, chest.Restore(sa), chest.Restore(sb), chest.MergeRequest{ID: "m", Seed: seed})
		if err != nil {
			t.Fatal(err)
		}
		if len(m.State().Contents) != odds.Size {
			t.Fatalf("merged %d items, odds say %d", len(m.State().Contents), odds.Size)
		}
		for _, trait := range m.State().Traits {
			kept[trait.ID]++
			if trait.ID == "moss" && trait.Intensity > .7 {
				upgraded++
			}
		}
	}
	for _, o := range want {
		if got := float64(kept[o.ID]) / runs; math.Abs(got-o.Keep) > .03 {
			t.Fatalf("%s stayed in %.3f of merges, odds say %.3f", o.ID, got, o.Keep)
		}
	}
	if got := float64(upgraded) / runs; math.Abs(got-odds.Traits[1].Upgrade) > .03 {
		t.Fatalf("moss rose a tier in %.3f of merges, odds say %.3f", got, odds.Traits[1].Upgrade)
	}
	other, _ := chest.Issue(rb, chest.IssueRequest{ID: "x", Owner: "someone", Type: "ender", Seed: 3})
	if _, err := chest.Odds(rb, chest.Restore(sa), other, nil); !errors.Is(err, chest.ErrMismatch) {
		t.Fatalf("odds across owners: %v", err)
	}
}

func TestReissueFillsALegacyChestFromItsSeed(t *testing.T) {
	rb := rulebooktest.Build(t)
	issued := issue(t, rb, "c", 11).State()
	legacy := chest.State{ID: "c", Owner: issued.Owner, Type: issued.Type, Seed: issued.Seed, Status: chest.Opened,
		Session: "s1", Drop: &chest.Drop{Item: "item-a"}}
	if !legacy.Legacy() || issued.Legacy() {
		t.Fatal("only a chest without a revision is legacy")
	}
	c, err := chest.Reissue(rb, legacy, nil)
	if err != nil {
		t.Fatal(err)
	}
	s := c.State()
	if s.Legacy() || s.Origin.Source != chest.SourceLegacy || s.Status != chest.Opened || s.Session != "s1" {
		t.Fatalf("reissued %+v", s)
	}
	if s.Drop == nil || s.Drop.Item != "item-a" || s.Drop.State != rulebook.Intact {
		t.Fatalf("drop %+v", s.Drop)
	}
	if !reflect.DeepEqual(s.Contents, issued.Contents) || !reflect.DeepEqual(s.Traits, issued.Traits) || s.Rarity != issued.Rarity || s.Condition != issued.Condition {
		t.Fatal("a reissued chest is what its seed issues")
	}
}
