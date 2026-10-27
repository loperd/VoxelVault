package domain

import (
	"math"
	"time"

	"github.com/voxel-vault/api/inventory/domain/chest"
	"github.com/voxel-vault/api/inventory/domain/dice"
	"github.com/voxel-vault/api/inventory/domain/rulebook"
)

const Retired = "merged"

// StoredChest includes the historical reward receipt. Reopening a chest never receives
// an item again, even after that item is sold, merged or repaired.
type StoredChest struct {
	State     chest.State
	CreatedAt time.Time
	OpenedAt  *time.Time
	Reward    *Item
}

func (c StoredChest) Clone() StoredChest {
	c.State = chest.Restore(c.State).State()
	if c.OpenedAt != nil {
		at := *c.OpenedAt
		c.OpenedAt = &at
	}
	if c.Reward != nil {
		item := *c.Reward
		c.Reward = &item
	}
	return c
}
func ValidateChest(c StoredChest) error {
	s := c.State
	if !ValidID(s.ID) || !ValidID(s.Owner) || !ValidID(s.Type) || math.IsNaN(s.Condition) || math.IsInf(s.Condition, 0) || s.Condition < 0 || s.Condition > 1 {
		return ErrInvalid
	}
	if !s.Legacy() {
		if !ValidID(s.Revision) || !ValidID(s.Rarity) || !ValidID(s.Origin.Source) || len(s.Contents) == 0 {
			return ErrInvalid
		}
		seen := map[string]bool{}
		for _, slot := range s.Contents {
			if !ValidID(slot.Item) || slot.Weight <= 0 || math.IsNaN(slot.Weight) || math.IsInf(slot.Weight, 0) || seen[slot.Item] {
				return ErrInvalid
			}
			seen[slot.Item] = true
		}
	}
	seenTraits := map[string]bool{}
	for _, t := range s.Traits {
		if !ValidID(t.ID) || t.Intensity <= 0 || t.Intensity > 1 || math.IsNaN(t.Intensity) || seenTraits[t.ID] {
			return ErrInvalid
		}
		seenTraits[t.ID] = true
	}
	for _, id := range s.Origin.Parents {
		if !ValidID(id) || id == s.ID {
			return ErrInvalid
		}
	}
	if s.Origin.Source == chest.SourceMerge && (len(s.Origin.Parents) != 2 || s.Origin.Parents[0] == s.Origin.Parents[1]) {
		return ErrInvalid
	}
	switch s.Status {
	case chest.Available, chest.Merged:
		if s.Session != "" || s.Drop != nil || s.DestroyedAt != "" || c.OpenedAt != nil {
			return ErrInvalid
		}
	case chest.Opening:
		if !ValidID(s.Session) || s.Drop != nil || s.DestroyedAt != "" || c.OpenedAt != nil {
			return ErrInvalid
		}
	case chest.Opened:
		if !ValidID(s.Session) || s.Drop == nil || !ValidID(s.Drop.Item) || s.DestroyedAt != "" {
			return ErrInvalid
		}
		if rank(s.Drop.State) < 0 && !(s.Legacy() && s.Drop.State == "") {
			return ErrInvalid
		}
	case chest.Destroyed:
		if !ValidID(s.Session) || s.Drop != nil || c.OpenedAt != nil || (s.DestroyedAt != chest.AtImpact && s.DestroyedAt != chest.AtOpening) {
			return ErrInvalid
		}
	default:
		return ErrInvalid
	}
	if c.Reward != nil {
		item := *c.Reward
		if s.Status != chest.Opened || ValidateOpeningItem(item) != nil || item.Owner != s.Owner || item.Origin != s.ID || item.Definition != s.Drop.Item {
			return ErrInvalid
		}
		condition := s.Drop.State
		if s.Legacy() && condition == "" {
			condition = "intact"
		}
		if item.Condition != condition {
			return ErrInvalid
		}
	}
	return nil
}

// MergeItems is Inventory-local: workshop-reserved items cannot be consumed by a merge.
func MergeItems(rb *rulebook.Rulebook, a, b Item, seed uint64, base rulebook.Situation) (Item, Item, error) {
	if a.Status != Available || b.Status != Available || a.OperationID != "" || b.OperationID != "" {
		return Item{}, Item{}, ErrBusy
	}
	if a.ID == b.ID || a.Owner != b.Owner || a.Definition != b.Definition || rank(a.Condition) <= 0 || rank(b.Condition) <= 0 {
		return Item{}, Item{}, ErrConflict
	}
	def, kind, ok := rb.Item(a.Definition)
	if !ok {
		return Item{}, Item{}, ErrNotFound
	}
	if rank(b.Condition) < rank(a.Condition) {
		a, b = b, a
	}
	s := base.With(rulebook.Situation{"type": kind.ID, "collection": kind.Collection, "item.rarity": def.Rarity, "item.state": a.Condition})
	if dice.New(seed, dice.StreamItemMerge).Chance(rb.Value("item.merge.repair", s)) {
		a.Condition = conditions[rank(a.Condition)-1]
	}
	b.Status = Retired
	return a, b, nil
}
