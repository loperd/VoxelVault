package chest

import (
	"fmt"
	"math"
	"slices"

	"github.com/voxel-vault/api/inventory/domain/dice"
	"github.com/voxel-vault/api/inventory/domain/rulebook"
)

type MergeRequest struct {
	ID        string
	Seed      uint64
	Situation rulebook.Situation
}

// Merge turns two available chests of one owner and one type into a new one; both are spent.
// It rolls the plan (see planMerge): each trait stays and may rise a tier by its chances, the
// most intense of exclusive traits stays, and the contents are the union cut to content.size
// purely at random, so the player may lose items of either chest. Rarity and condition are
// appraised anew.
func Merge(rb *rulebook.Rulebook, a, b *Chest, req MergeRequest) (*Chest, error) {
	c, err := merged(rb, a, b, req.ID, req.Seed)
	if err != nil {
		return nil, err
	}
	s := c.situation(rb, req.Situation)
	plan := planMerge(rb, a, b, s)
	d := dice.New(req.Seed, dice.StreamMerge)
	var kept []Trait
	for _, p := range plan.traits {
		if !d.Chance(p.keep) {
			continue
		}
		trait := p.Trait
		if p.upgrade > 0 && d.Chance(p.upgrade) {
			trait.Intensity = p.risen
		}
		kept = append(kept, trait)
	}
	c.s.Traits = withoutConflicts(rb, kept)
	union := plan.contents
	for i := len(union) - 1; i > 0; i-- {
		j := d.Index(i + 1)
		union[i], union[j] = union[j], union[i]
	}
	c.s.Contents = union[:plan.size]
	c.appraise(rb, s)
	a.s.Status, b.s.Status = Merged, Merged
	return c, nil
}

// MergeOdds is what merging two chests would make, by the chances Merge rolls: each trait of
// either chest with its chance to be on the new chest and to be there a tier higher; of the
// Contents items the two hold together, the new chest keeps Size, each with the chance ItemKeep.
type MergeOdds struct {
	Traits         []TraitOdds
	Contents, Size int
	ItemKeep       float64
}

type TraitOdds struct {
	ID            string
	Keep, Upgrade float64
}

// Odds tells what merging a and b would make; nothing changes. Exclusive traits are settled the
// way Merge settles them, over every way their rolls can fall.
func Odds(rb *rulebook.Rulebook, a, b *Chest, base rulebook.Situation) (MergeOdds, error) {
	c, err := merged(rb, a, b, "", 0)
	if err != nil {
		return MergeOdds{}, err
	}
	plan := planMerge(rb, a, b, c.situation(rb, base))
	odds := MergeOdds{Traits: make([]TraitOdds, len(plan.traits)), Contents: len(plan.contents), Size: plan.size}
	if odds.Contents > 0 {
		odds.ItemKeep = float64(plan.size) / float64(odds.Contents)
	}
	for i, p := range plan.traits {
		odds.Traits[i].ID = p.ID
	}
	for _, rivals := range plan.rivals(rb) {
		settle(rb, plan.traits, rivals, odds.Traits)
	}
	return odds, nil
}

// mergePlan is all a merge decides before the dice: each trait of either chest (the more intense
// of twins) with its chance to stay and, once kept, to rise to risen; and the items the new chest
// keeps size of.
type mergePlan struct {
	traits   []plannedTrait
	contents []Slot
	size     int
}

type plannedTrait struct {
	Trait
	keep, upgrade, risen float64
}

// planMerge reads the merge.<group>.* chances: traits of "reset" groups (damage) and traits the
// rulebook no longer knows never stay; one held by a single chest stays by keepOne; one held by
// both stays by keepBoth and then rises a tier by upgrade, unless it is at the top tier.
func planMerge(rb *rulebook.Rulebook, a, b *Chest, s rulebook.Situation) mergePlan {
	var plan mergePlan
	for _, trait := range a.s.Traits {
		plan.traits = append(plan.traits, plannedTrait{Trait: trait})
	}
	for _, trait := range b.s.Traits {
		if i := slices.IndexFunc(plan.traits, func(p plannedTrait) bool { return p.ID == trait.ID }); i < 0 {
			plan.traits = append(plan.traits, plannedTrait{Trait: trait})
		} else if trait.Intensity > plan.traits[i].Intensity {
			plan.traits[i].Trait = trait
		}
	}
	for i := range plan.traits {
		p := &plan.traits[i]
		def, known := rb.Trait(p.ID)
		if !known {
			continue
		}
		group, _ := rb.Group(def.Group)
		if group.Merge != rulebook.MergeKeep {
			continue
		}
		prefix := "merge." + group.ID
		if !hasTrait(a.s.Traits, p.ID) || !hasTrait(b.s.Traits, p.ID) {
			p.keep = rb.Value(prefix+".keepOne", s)
			continue
		}
		p.keep = rb.Value(prefix+".keepBoth", s)
		if p.risen = nextTier(rb, p.Trait); p.risen > p.Intensity {
			p.upgrade = rb.Value(prefix+".upgrade", s)
		}
	}
	plan.contents = append([]Slot{}, a.s.Contents...)
	for _, slot := range b.s.Contents {
		if !holds(plan.contents, slot.Item) {
			plan.contents = append(plan.contents, slot)
		}
	}
	plan.size = min(max(int(rb.Value("content.size", s)), 1), len(plan.contents))
	return plan
}

// rivals groups the plan's traits (by index, in order) that one exclusive key lets only one of
// stay; a trait with no key is alone.
func (p mergePlan) rivals(rb *rulebook.Rulebook) [][]int {
	var groups [][]int
	byKey := map[string]int{}
	for i, trait := range p.traits {
		def, known := rb.Trait(trait.ID)
		if !known {
			groups = append(groups, []int{i})
			continue
		}
		if g, ok := byKey[def.Exclusive]; ok {
			groups[g] = append(groups[g], i)
			continue
		}
		if def.Exclusive != "" {
			byKey[def.Exclusive] = len(groups)
		}
		groups = append(groups, []int{i})
	}
	return groups
}

// settle adds to odds, for rivals, the chance of each to be on the new chest and to be there
// risen: every way their rolls fall (gone, kept, kept risen), settled by withoutConflicts.
func settle(rb *rulebook.Rulebook, plan []plannedTrait, rivals []int, odds []TraitOdds) {
	var walk func(n int, chance float64, kept []Trait)
	walk = func(n int, chance float64, kept []Trait) {
		if chance == 0 {
			return
		}
		if n == len(rivals) {
			for _, trait := range withoutConflicts(rb, kept) {
				i := rivals[slices.IndexFunc(rivals, func(i int) bool { return plan[i].ID == trait.ID })]
				odds[i].Keep += chance
				if plan[i].upgrade > 0 && trait.Intensity == plan[i].risen {
					odds[i].Upgrade += chance
				}
			}
			return
		}
		p := plan[rivals[n]]
		walk(n+1, chance*(1-p.keep), kept)
		walk(n+1, chance*p.keep*(1-p.upgrade), append(slices.Clip(kept), p.Trait))
		risen := p.Trait
		risen.Intensity = p.risen
		walk(n+1, chance*p.keep*p.upgrade, append(slices.Clip(kept), risen))
	}
	walk(0, 1, nil)
}

// merged is the chest two would make, before any roll: same owner and type, both available.
func merged(rb *rulebook.Rulebook, a, b *Chest, id string, seed uint64) (*Chest, error) {
	if a.s.ID == b.s.ID || a.s.Owner != b.s.Owner || a.s.Type != b.s.Type {
		return nil, ErrMismatch
	}
	if a.s.Status != Available || b.s.Status != Available {
		return nil, ErrUnavailable
	}
	if _, ok := rb.Type(a.s.Type); !ok {
		return nil, fmt.Errorf("%w %q", ErrUnknownType, a.s.Type)
	}
	return &Chest{s: State{
		ID: id, Owner: a.s.Owner, Type: a.s.Type, Revision: rb.Revision(), Seed: seed,
		Origin: Origin{Source: SourceMerge, Parents: []string{a.s.ID, b.s.ID}}, Status: Available,
	}}, nil
}

// nextTier lifts an intensity to the threshold of the tier above; the top tier stays as it is.
func nextTier(rb *rulebook.Rulebook, trait Trait) float64 {
	thresholds := rb.TierThresholds(trait.ID)
	if tier := rb.Tier(trait.ID, trait.Intensity); tier < len(thresholds) {
		return math.Max(trait.Intensity, thresholds[tier])
	}
	return trait.Intensity
}

// withoutConflicts keeps, of traits sharing an exclusive key, only the most intense.
func withoutConflicts(rb *rulebook.Rulebook, traits []Trait) []Trait {
	var out []Trait
	for _, trait := range traits {
		def, known := rb.Trait(trait.ID)
		if !known {
			continue
		}
		rival := -1
		for i, kept := range out {
			if excludes(rb, kept.ID, def) {
				rival = i
			}
		}
		switch {
		case rival < 0:
			out = append(out, trait)
		case trait.Intensity > out[rival].Intensity:
			out[rival] = trait
		}
	}
	return out
}

func hasTrait(traits []Trait, id string) bool {
	for _, trait := range traits {
		if trait.ID == id {
			return true
		}
	}
	return false
}
