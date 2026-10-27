package application

import (
	"context"
	"github.com/voxel-vault/api/inventory/domain"
)

type Offers struct {
	Repair        *domain.Quote
	Salvage, Sell domain.Quote
	MergeWith     string
	MergeRepair   float64
}
type PricedItem struct {
	Item   domain.Item
	Offers *Offers
}
type ItemReader interface {
	Items(context.Context, string) ([]domain.Item, error)
}
type OffersPolicy interface {
	Offers([]domain.Item) map[string]Offers
}
type Catalog struct {
	Reader     ItemReader
	Policy     OffersPolicy
	Authorizer Authorizer
}

func (c Catalog) Items(ctx context.Context, owner string) ([]PricedItem, error) {
	var authorizationErr error
	ctx, authorizationErr = authorize(ctx, c.Authorizer, ReadItems, Resource{Kind: "owner", ID: owner, Owner: owner})
	if authorizationErr != nil {
		return nil, authorizationErr
	}
	if c.Reader == nil || c.Policy == nil || !domain.ValidID(owner) {
		return nil, domain.ErrInvalid
	}
	items, err := c.Reader.Items(ctx, owner)
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		if item.Owner != owner {
			return nil, ErrForbidden
		}
	}
	offers := c.Policy.Offers(items)
	result := []PricedItem{}
	for _, i := range items {
		r := PricedItem{Item: i}
		if o, ok := offers[i.ID]; ok && i.Status == domain.Available {
			r.Offers = &o
		}
		result = append(result, r)
	}
	return result, nil
}
