// Package rulebook adapts the existing Inventory rulebook during the context migration.
// Its legacy quote models are translated here and never enter the new application core.
package rulebook

import (
	legacy "github.com/voxel-vault/api/internal/domain/inventory"
	"github.com/voxel-vault/api/internal/inventory/application"
	"github.com/voxel-vault/api/internal/inventory/domain"
	rules "github.com/voxel-vault/api/internal/inventory/domain/rulebook"
	"time"
)

type Pricing struct {
	Current func() *rules.Rulebook
	Clock   func() time.Time
}

func (p Pricing) Offers(items []domain.Item) map[string]application.Offers {
	result := map[string]application.Offers{}
	if p.Current == nil || p.Clock == nil {
		return result
	}
	rb := p.Current()
	if rb == nil {
		return result
	}
	now := p.Clock().UTC()
	s := rules.Situation{"events": rb.ActiveEvents(now), "time.weekday": int(now.Weekday()), "time.hour": now.Hour()}
	var available []legacy.Item
	for _, i := range items {
		if i.Status == domain.Available {
			available = append(available, legacy.Item{ID: i.ID, Item: i.Definition, State: i.Condition, Origin: i.Origin})
		}
	}
	if len(items) == 0 {
		return result
	}
	inv := legacy.Restore(items[0].Owner, available)
	quote := func(asset string, units int64) domain.Quote {
		return domain.Quote{Asset: asset, Units: units, Revision: rb.Revision()}
	}
	for _, i := range available {
		o, err := inv.Quote(rb, i.ID, s)
		if err != nil {
			continue
		}
		if o.Salvage.Value <= 0 || o.Sell.Value <= 0 {
			continue
		}
		r := application.Offers{Salvage: quote(o.Salvage.Resource, o.Salvage.Value), Sell: quote(o.Sell.Resource, o.Sell.Value), MergeWith: o.MergeWith, MergeRepair: o.MergeRepair}
		if o.Repair != nil && o.Repair.Value > 0 {
			q := quote(o.Repair.Resource, o.Repair.Value)
			r.Repair = &q
		}
		result[i.ID] = r
	}
	return result
}

func (p Pricing) Quote(item domain.Item, action domain.Action) (domain.Quote, error) {
	if p.Current == nil || p.Clock == nil {
		return domain.Quote{}, domain.ErrInvalid
	}
	rb := p.Current()
	if rb == nil {
		return domain.Quote{}, domain.ErrInvalid
	}
	now := p.Clock().UTC()
	s := rules.Situation{"events": rb.ActiveEvents(now), "time.weekday": int(now.Weekday()), "time.hour": now.Hour()}
	inv := legacy.Restore(item.Owner, []legacy.Item{{ID: item.ID, Item: item.Definition, State: item.Condition, Origin: item.Origin}})
	offers, err := inv.Quote(rb, item.ID, s)
	if err != nil {
		return domain.Quote{}, err
	}
	result := domain.Quote{Revision: rb.Revision()}
	switch action {
	case domain.Repair:
		if offers.Repair == nil {
			return result, domain.ErrInvalid
		}
		result.Asset, result.Units = offers.Repair.Resource, offers.Repair.Value
	case domain.Sell:
		result.Asset, result.Units = offers.Sell.Resource, offers.Sell.Value
	case domain.Salvage:
		result.Asset, result.Units = offers.Salvage.Resource, offers.Salvage.Value
	default:
		return result, domain.ErrInvalid
	}
	return result, nil
}
