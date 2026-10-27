package local

import (
	"context"
	"strconv"
	"time"

	"github.com/voxel-vault/api/inventory/application"
	v1 "github.com/voxel-vault/api/inventory/contracts/v1"
	"github.com/voxel-vault/api/inventory/domain"
)

type CollectionClient struct{ Service application.CollectionService }

var _ v1.CollectionClient = CollectionClient{}

func publicItem(item domain.Item) v1.Item {
	return v1.Item{ID: item.ID, Owner: item.Owner, Definition: item.Definition, Condition: item.Condition, Origin: item.Origin, Status: item.Status, OperationID: item.OperationID}
}
func publicChest(r domain.StoredChest) v1.OpeningChest {
	s := r.State
	x := v1.OpeningChest{ID: s.ID, Owner: s.Owner, Type: s.Type, Seed: strconv.FormatUint(s.Seed, 10), Revision: s.Revision, Rarity: s.Rarity, Condition: s.Condition, Source: s.Origin.Source, Parents: append([]string(nil), s.Origin.Parents...), Status: string(s.Status), Session: s.Session, DestroyedAt: string(s.DestroyedAt), CreatedAt: r.CreatedAt.Format(time.RFC3339Nano), Contents: []v1.ChestSlot{}, Traits: []v1.ChestTrait{}}
	for _, c := range s.Contents {
		x.Contents = append(x.Contents, v1.ChestSlot{Item: c.Item, Weight: c.Weight})
	}
	for _, t := range s.Traits {
		x.Traits = append(x.Traits, v1.ChestTrait{ID: t.ID, Intensity: t.Intensity, Seed: t.Seed})
	}
	if s.Drop != nil {
		x.Drop = &v1.ChestDrop{Item: s.Drop.Item, Condition: s.Drop.State}
	}
	if r.OpenedAt != nil {
		at := r.OpenedAt.Format(time.RFC3339Nano)
		x.OpenedAt = &at
	}
	if r.Reward != nil {
		v := r.Reward
		x.Reward = &v1.OpeningItem{ID: v.ID, Owner: v.Owner, Definition: v.Definition, Condition: v.Condition, Origin: v.Origin}
	}
	return x
}
func (c CollectionClient) Issue(ctx context.Context, r v1.IssueRequest) ([]v1.OpeningChest, error) {
	cs, err := c.Service.Issue(ctx, application.IssueRequest{Owner: r.Owner, RequestID: r.RequestID, Type: r.Type, Source: r.Source, Count: r.Count})
	if err != nil {
		return nil, publicError(err)
	}
	result := []v1.OpeningChest{}
	for _, ch := range cs {
		result = append(result, publicChest(ch))
	}
	return result, nil
}
func (c CollectionClient) GrantStarter(ctx context.Context, owner string, grants []v1.Grant) error {
	gs := []application.Grant{}
	for _, g := range grants {
		gs = append(gs, application.Grant{Type: g.Type, Count: g.Count})
	}
	return publicError(c.Service.GrantStarter(ctx, owner, gs))
}
func (c CollectionClient) Chests(ctx context.Context, owner string) ([]v1.OpeningChest, error) {
	cs, err := c.Service.Chests(ctx, owner)
	if err != nil {
		return nil, publicError(err)
	}
	result := []v1.OpeningChest{}
	for _, ch := range cs {
		result = append(result, publicChest(ch))
	}
	return result, nil
}
func (c CollectionClient) Claim(ctx context.Context, owner, id, session string) (v1.Claimed, error) {
	r, l, err := c.Service.Claim(ctx, owner, id, session)
	if err != nil {
		return v1.Claimed{}, publicError(err)
	}
	result := v1.Claimed{Chest: publicChest(r)}
	if l != nil {
		result.Landing = &v1.Landing{Destroyed: l.Destroyed}
		if l.Damage != nil {
			t := l.Damage
			result.Landing.Damage = &v1.ChestTrait{ID: t.ID, Intensity: t.Intensity, Seed: t.Seed}
		}
	}
	return result, nil
}
func (c CollectionClient) Open(ctx context.Context, owner, id, session string) (v1.OpeningChest, error) {
	r, err := c.Service.Open(ctx, owner, id, session)
	if err != nil {
		return v1.OpeningChest{}, publicError(err)
	}
	return publicChest(r), nil
}
func pair(r v1.PairRequest) application.PairRequest {
	return application.PairRequest{Owner: r.Owner, RequestID: r.RequestID, A: r.A, B: r.B}
}
func (c CollectionClient) MergeChests(ctx context.Context, r v1.PairRequest) (v1.OpeningChest, error) {
	ch, err := c.Service.MergeChests(ctx, pair(r))
	if err != nil {
		return v1.OpeningChest{}, publicError(err)
	}
	return publicChest(ch), nil
}
func (c CollectionClient) MergeItems(ctx context.Context, r v1.PairRequest) (v1.Item, error) {
	item, err := c.Service.MergeItems(ctx, pair(r))
	if err != nil {
		return v1.Item{}, publicError(err)
	}
	return publicItem(item), nil
}
func (c CollectionClient) MergeOdds(ctx context.Context, owner, a, b string) (v1.MergeOdds, error) {
	r, err := c.Service.MergeOdds(ctx, owner, a, b)
	if err != nil {
		return v1.MergeOdds{}, publicError(err)
	}
	result := v1.MergeOdds{Contents: r.Contents, Size: r.Size, ItemKeep: r.ItemKeep, Traits: []v1.TraitOdds{}}
	for _, t := range r.Traits {
		result.Traits = append(result.Traits, v1.TraitOdds{ID: t.ID, Keep: t.Keep, Upgrade: t.Upgrade})
	}
	return result, nil
}
func (c CollectionClient) Items(ctx context.Context, owner string) ([]v1.Item, error) {
	items, err := c.Service.Items(ctx, owner)
	if err != nil {
		return nil, publicError(err)
	}
	result := []v1.Item{}
	for _, item := range items {
		result = append(result, publicItem(item))
	}
	return result, nil
}
