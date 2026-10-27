package chest

import (
	"fmt"

	"github.com/voxel-vault/api/inventory/domain/dice"
	"github.com/voxel-vault/api/inventory/domain/rulebook"
)

type IssueRequest struct {
	ID, Owner, Type string
	// Source is who issues the chest: starter, admin, event-reward, purchase.
	Source string
	Seed   uint64
	// Situation carries the time, events and player; the chest adds its own fields.
	Situation rulebook.Situation
}

// Issue makes a new chest: first its traits, then its contents (traits may bring better items),
// then the rarity and condition that follow from them, frozen with the rulebook's revision.
func Issue(rb *rulebook.Rulebook, req IssueRequest) (*Chest, error) {
	chestType, ok := rb.Type(req.Type)
	if !ok {
		return nil, fmt.Errorf("%w %q", ErrUnknownType, req.Type)
	}
	c := &Chest{s: State{
		ID: req.ID, Owner: req.Owner, Type: req.Type, Revision: rb.Revision(), Seed: req.Seed,
		Origin: Origin{Source: req.Source}, Status: Available,
	}}
	d := dice.New(req.Seed, dice.StreamIssue)
	s := c.situation(rb, req.Situation)
	c.s.Traits = rollTraits(rb, s, d)
	contents := rollContents(rb, chestType, s, d)
	if len(contents) == 0 {
		return nil, fmt.Errorf("%w: %q", ErrEmpty, req.Type)
	}
	c.s.Contents = bonusSlots(rb, chestType, contents, c.s.Traits, s, d)
	c.appraise(rb, s)
	return c, nil
}

// rollTraits gives each group its chance; a group that hits gets count.min…count.max distinct
// traits by weight, never two of one exclusive key.
func rollTraits(rb *rulebook.Rulebook, s rulebook.Situation, d *dice.Dice) []Trait {
	var traits []Trait
	bias := rb.Value("trait.intensity.bias", s)
	for _, group := range rb.Groups() {
		prefix := "trait.group." + group.ID
		if !d.Chance(rb.Value(prefix+".chance", s)) {
			continue
		}
		count := d.Between(int(rb.Value(prefix+".count.min", s)), int(rb.Value(prefix+".count.max", s)))
		candidates := rb.TraitsOf(group.ID)
		for range count {
			weights := make([]float64, len(candidates))
			for i, def := range candidates {
				if fits(rb, traits, def) {
					weights[i] = rb.Value("trait."+def.ID+".weight", s)
				}
			}
			pick := d.Weighted(weights)
			if pick < 0 {
				break
			}
			traits = append(traits, Trait{ID: candidates[pick].ID, Intensity: d.Weak(bias), Seed: d.Uint32()})
		}
	}
	return traits
}

// fits: a trait joins a chest it is not on yet and whose traits do not exclude it.
func fits(rb *rulebook.Rulebook, traits []Trait, def *rulebook.TraitDef) bool {
	for _, trait := range traits {
		if trait.ID == def.ID || excludes(rb, trait.ID, def) {
			return false
		}
	}
	return true
}

func excludes(rb *rulebook.Rulebook, traitID string, def *rulebook.TraitDef) bool {
	other, ok := rb.Trait(traitID)
	return ok && def.Exclusive != "" && other.Exclusive == def.Exclusive && other.ID != def.ID
}

func poolWeight(rb *rulebook.Rulebook, item rulebook.Item, s rulebook.Situation) float64 {
	return rb.Value("pool.weight."+item.Rarity, s.With(rulebook.Situation{"item.rarity": item.Rarity}))
}

// rollContents draws content.size distinct items from the pool by weight.
func rollContents(rb *rulebook.Rulebook, chestType *rulebook.ChestType, s rulebook.Situation, d *dice.Dice) []Slot {
	weights := make([]float64, len(chestType.Pool))
	for i, item := range chestType.Pool {
		weights[i] = poolWeight(rb, item, s)
	}
	size := min(int(rb.Value("content.size", s)), len(chestType.Pool))
	contents := make([]Slot, 0, size)
	for len(contents) < size {
		pick := d.Weighted(weights)
		if pick < 0 {
			break
		}
		contents = append(contents, Slot{Item: chestType.Pool[pick].ID, Weight: weights[pick]})
		weights[pick] = 0
	}
	return contents
}

// bonusSlots: each tier of a trait with bonusSlotsPerTier replaces one of the lowest-rated items
// below the trait's bonus rarity with a pool item at or above it (End III → three rare+ items).
func bonusSlots(rb *rulebook.Rulebook, chestType *rulebook.ChestType, contents []Slot, traits []Trait, s rulebook.Situation, d *dice.Dice) []Slot {
	for _, trait := range traits {
		def, _ := rb.Trait(trait.ID)
		minRank := max(0, rb.RarityRank(def.BonusMinRarity))
		slots := int(rb.Value("trait."+trait.ID+".bonusSlotsPerTier", s)) * rb.Tier(trait.ID, trait.Intensity)
		for range slots {
			out := lowestBelow(rb, contents, minRank, d)
			if out < 0 {
				break
			}
			weights := make([]float64, len(chestType.Pool))
			for i, item := range chestType.Pool {
				if rb.RarityRank(item.Rarity) >= minRank && !holds(contents, item.ID) {
					weights[i] = poolWeight(rb, item, s)
				}
			}
			in := d.Weighted(weights)
			if in < 0 {
				break
			}
			contents[out] = Slot{Item: chestType.Pool[in].ID, Weight: weights[in]}
		}
	}
	return contents
}

// lowestBelow picks at random one of the lowest-rated slots rated below rank; -1 if none is.
func lowestBelow(rb *rulebook.Rulebook, contents []Slot, rank int, d *dice.Dice) int {
	var lowest []int
	low := rank
	for i, slot := range contents {
		switch r := itemRank(rb, slot.Item); {
		case r < low:
			low, lowest = r, []int{i}
		case r == low && r < rank:
			lowest = append(lowest, i)
		}
	}
	if len(lowest) == 0 {
		return -1
	}
	return lowest[d.Index(len(lowest))]
}

func holds(contents []Slot, itemID string) bool {
	for _, slot := range contents {
		if slot.Item == itemID {
			return true
		}
	}
	return false
}

// SourceLegacy marks a chest issued before chests carried their metadata.
const SourceLegacy = "legacy"

// Reissue fills in a chest stored before chests carried contents, traits, rarity and condition:
// they are rolled from its own seed as at issue, and its status, session and drop are kept.
func Reissue(rb *rulebook.Rulebook, legacy State, s rulebook.Situation) (*Chest, error) {
	source := legacy.Origin.Source
	if source == "" {
		source = SourceLegacy
	}
	c, err := Issue(rb, IssueRequest{ID: legacy.ID, Owner: legacy.Owner, Type: legacy.Type, Source: source, Seed: legacy.Seed, Situation: s})
	if err != nil {
		return nil, err
	}
	c.s.Status, c.s.Session, c.s.DestroyedAt = legacy.Status, legacy.Session, legacy.DestroyedAt
	if legacy.Drop != nil {
		drop := *legacy.Drop
		if drop.State == "" {
			drop.State = rulebook.Intact
		}
		c.s.Drop = &drop
	}
	return c, nil
}

// Legacy: the chest was stored before chests carried their metadata.
func (s State) Legacy() bool { return s.Revision == "" }
