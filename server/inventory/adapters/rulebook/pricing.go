// Package rulebook prices workshop actions from the Inventory rulebook.
package rulebook

import (
	"fmt"
	"math"
	"time"

	"github.com/voxel-vault/api/inventory/application"
	"github.com/voxel-vault/api/inventory/domain"
	rules "github.com/voxel-vault/api/inventory/domain/rulebook"
)

// currency is the shared resource a sale pays in; every other asset is a collection's material.
const currency = "currency"

type Pricing struct {
	Current func() *rules.Rulebook
	Clock   func() time.Time
}

// priced is an item's worth in its state (item.value.<rarity> × item.state.<state>.value), its
// base value, the material of its collection and the situation its rules are read in.
type priced struct {
	worth, base float64
	material    string
	s           rules.Situation
}

func price(rb *rules.Rulebook, item domain.Item, s rules.Situation) (priced, error) {
	def, chest, ok := rb.Item(item.Definition)
	if !ok || rb.StateRank(item.Condition) < 0 {
		return priced{}, fmt.Errorf("%w in rulebook %s: %q", domain.ErrInvalid, rb.Revision(), item.Definition)
	}
	s = s.With(rules.Situation{"type": chest.ID, "collection": chest.Collection, "item.rarity": def.Rarity, "item.state": item.Condition})
	base := rb.Value("item.value."+def.Rarity, s)
	return priced{base * rb.Value("item.state."+item.Condition+".value", s), base, rb.Material(chest), s}, nil
}

func whole(v float64) int64 { return int64(math.Round(v)) }

func (p Pricing) ready() (*rules.Rulebook, rules.Situation) {
	if p.Current == nil || p.Clock == nil {
		return nil, nil
	}
	rb := p.Current()
	if rb == nil {
		return nil, nil
	}
	now := p.Clock().UTC()
	return rb, rules.Situation{"events": rb.ActiveEvents(now), "time.weekday": int(now.Weekday()), "time.hour": now.Hour()}
}

func (p Pricing) Offers(items []domain.Item) map[string]application.Offers {
	result := map[string]application.Offers{}
	rb, s := p.ready()
	if rb == nil {
		return result
	}
	var available []domain.Item
	for _, i := range items {
		if i.Status == domain.Available {
			available = append(available, i)
		}
	}
	quote := func(asset string, units int64) domain.Quote {
		return domain.Quote{Asset: asset, Units: units, Revision: rb.Revision()}
	}
	for _, i := range available {
		w, err := price(rb, i, s)
		if err != nil {
			continue
		}
		salvage, sell := whole(w.worth), whole(w.worth*rb.Value("item.sellRate", w.s))
		if salvage <= 0 || sell <= 0 {
			continue
		}
		o := application.Offers{Salvage: quote(w.material, salvage), Sell: quote(currency, sell)}
		if r := whole(w.base); rb.StateRank(i.Condition) > 0 && r > 0 {
			q := quote(w.material, r)
			o.Repair = &q
		}
		if twin := worstTwin(rb, available, i); twin != nil {
			// The twin in the better state stays (this item on a tie) and is mended by item.merge.repair.
			kept := i
			if rb.StateRank(twin.Condition) < rb.StateRank(i.Condition) {
				kept = *twin
			}
			if k, err := price(rb, kept, s); err == nil {
				o.MergeWith, o.MergeRepair = twin.ID, rb.Value("item.merge.repair", k.s)
			}
		}
		result[i.ID] = o
	}
	return result
}

// worstTwin is another damaged item of the same kind in the worst state, the one a merge costs
// least; nil when there is none.
func worstTwin(rb *rules.Rulebook, items []domain.Item, of domain.Item) *domain.Item {
	if rb.StateRank(of.Condition) <= 0 {
		return nil
	}
	var worst *domain.Item
	for j, other := range items {
		if other.ID != of.ID && other.Definition == of.Definition && rb.StateRank(other.Condition) > 0 &&
			(worst == nil || rb.StateRank(other.Condition) > rb.StateRank(worst.Condition)) {
			worst = &items[j]
		}
	}
	return worst
}

func (p Pricing) Quote(item domain.Item, action domain.Action) (domain.Quote, error) {
	rb, s := p.ready()
	if rb == nil {
		return domain.Quote{}, domain.ErrInvalid
	}
	w, err := price(rb, item, s)
	if err != nil {
		return domain.Quote{}, err
	}
	result := domain.Quote{Revision: rb.Revision()}
	switch action {
	case domain.Repair:
		if rb.StateRank(item.Condition) <= 0 || whole(w.base) <= 0 {
			return result, domain.ErrInvalid
		}
		result.Asset, result.Units = w.material, whole(w.base)
	case domain.Sell:
		result.Asset, result.Units = currency, whole(w.worth*rb.Value("item.sellRate", w.s))
	case domain.Salvage:
		result.Asset, result.Units = w.material, whole(w.worth)
	default:
		return result, domain.ErrInvalid
	}
	return result, nil
}
