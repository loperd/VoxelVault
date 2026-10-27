package chest

import (
	"math"

	"github.com/voxel-vault/api/inventory/domain/rulebook"
)

// Rarity is the highest rarity R such that the share of items rated R or above is at least the
// threshold. Items count by number, not weight: the player judges the set by eye. Any non-empty
// set is at least the lowest rarity.
func Rarity(rb *rulebook.Rulebook, contents []Slot, threshold float64) string {
	rarities := rb.Rarities()
	if len(contents) == 0 {
		return rarities[0]
	}
	for rank := len(rarities) - 1; rank > 0; rank-- {
		count := 0
		for _, slot := range contents {
			if itemRank(rb, slot.Item) >= rank {
				count++
			}
		}
		if float64(count)/float64(len(contents)) >= threshold {
			return rarities[rank]
		}
	}
	return rarities[0]
}

func itemRank(rb *rulebook.Rulebook, itemID string) int {
	item, _, ok := rb.Item(itemID)
	if !ok {
		return -1
	}
	return rb.RarityRank(item.Rarity)
}

// Wear is how worn each part is: the sum of intensity × condition of the traits covering it,
// capped at 1.
func Wear(rb *rulebook.Rulebook, traits []Trait) map[string]float64 {
	wear := make(map[string]float64, len(rb.Parts()))
	for _, part := range rb.Parts() {
		wear[part] = 0
	}
	for _, trait := range traits {
		def, ok := rb.Trait(trait.ID)
		if !ok {
			continue
		}
		for _, part := range def.Parts {
			wear[part] = math.Min(1, wear[part]+trait.Intensity*def.Condition)
		}
	}
	return wear
}

// Condition is 1 minus the wear of the worst part.
func Condition(rb *rulebook.Rulebook, traits []Trait) float64 {
	worst := 0.0
	for _, wear := range Wear(rb, traits) {
		worst = math.Max(worst, wear)
	}
	return 1 - worst
}
