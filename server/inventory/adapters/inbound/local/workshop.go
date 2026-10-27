package local

import (
	"context"
	"github.com/voxel-vault/api/inventory/application"
	v1 "github.com/voxel-vault/api/inventory/contracts/v1"
	"github.com/voxel-vault/api/inventory/domain"
	"strconv"
)

type WorkshopClient struct {
	Service *application.Service
	Catalog application.Catalog
}

func amount(q domain.Quote) v1.Amount {
	return v1.Amount{Asset: q.Asset, Units: strconv.FormatInt(q.Units, 10)}
}
func operation(o domain.Operation) v1.Operation {
	return v1.Operation{ID: o.ID, ItemID: o.ItemID, Action: string(o.Action), Stage: string(o.Stage), Version: o.Version, Quote: amount(o.Quote), Reason: o.Reason}
}
func (c WorkshopClient) Start(ctx context.Context, owner, request, item, action string) (v1.Operation, error) {
	o, err := c.Service.Start(ctx, application.Request{Owner: owner, RequestID: request, ItemID: item, Action: domain.Action(action)})
	return operation(o), publicError(err)
}
func (c WorkshopClient) Status(ctx context.Context, owner, id string) (v1.Operation, error) {
	o, err := c.Service.Operation(ctx, owner, id)
	return operation(o), publicError(err)
}
func (c WorkshopClient) Cancel(ctx context.Context, owner, id string) (v1.Operation, error) {
	o, err := c.Service.Cancel(ctx, owner, id)
	return operation(o), publicError(err)
}
func (c WorkshopClient) Items(ctx context.Context, owner string) ([]v1.PricedItem, error) {
	items, err := c.Catalog.Items(ctx, owner)
	if err != nil {
		return nil, publicError(err)
	}
	result := []v1.PricedItem{}
	for _, i := range items {
		r := v1.PricedItem{Item: publicItem(i.Item)}
		if o := i.Offers; o != nil {
			r.Offers = &v1.Offers{Salvage: amount(o.Salvage), Sell: amount(o.Sell), MergeWith: o.MergeWith, MergeRepair: o.MergeRepair}
			if o.Repair != nil {
				q := amount(*o.Repair)
				r.Offers.Repair = &q
			}
		}
		result = append(result, r)
	}
	return result, nil
}
