package local

import (
	"context"
	"strconv"
	"time"

	"github.com/voxel-vault/api/inventory/application"
	v1 "github.com/voxel-vault/api/inventory/contracts/v1"
	"github.com/voxel-vault/api/inventory/domain"
	"github.com/voxel-vault/api/inventory/domain/chest"
)

type ChestsOpeningClient struct {
	Service application.ChestsOpeningService
}

func (c ChestsOpeningClient) ImportChests(ctx context.Context, in v1.ChestsOpening) error {
	r, err := decodeChestsOpening(in)
	if err != nil {
		return err
	}
	return publicError(c.Service.Import(ctx, r))
}

func (c ChestsOpeningClient) ValidateChestsOpening(ctx context.Context, in v1.ChestsOpening) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r, err := decodeChestsOpening(in)
	if err != nil {
		return err
	}
	return publicError(application.ValidateChestsOpening(r))
}

func decodeChestsOpening(in v1.ChestsOpening) (application.ChestsOpening, error) {
	r := application.ChestsOpening{Source: in.Source, Digest: in.Digest}
	for _, o := range in.Owners {
		var at *time.Time
		if o.StarterGrantedAt != nil {
			v, err := time.Parse(time.RFC3339Nano, *o.StarterGrantedAt)
			if err != nil {
				return r, &v1.Error{Code: v1.Invalid}
			}
			at = &v
		}
		r.Owners = append(r.Owners, application.OpeningOwner{ID: o.ID, StarterGrantedAt: at})
	}
	for _, x := range in.Chests {
		seed, err := strconv.ParseUint(x.Seed, 10, 64)
		if err != nil || strconv.FormatUint(seed, 10) != x.Seed {
			return r, &v1.Error{Code: v1.Invalid}
		}
		at, err := time.Parse(time.RFC3339Nano, x.CreatedAt)
		if err != nil {
			return r, &v1.Error{Code: v1.Invalid}
		}
		record := domain.StoredChest{State: chest.State{ID: x.ID, Owner: x.Owner, Type: x.Type, Seed: seed, Revision: x.Revision, Rarity: x.Rarity, Condition: x.Condition, Status: chest.Status(x.Status), Session: x.Session, DestroyedAt: chest.Moment(x.DestroyedAt), Origin: chest.Origin{Source: x.Source, Parents: append([]string(nil), x.Parents...)}}, CreatedAt: at}
		for _, slot := range x.Contents {
			record.State.Contents = append(record.State.Contents, chest.Slot{Item: slot.Item, Weight: slot.Weight})
		}
		for _, trait := range x.Traits {
			record.State.Traits = append(record.State.Traits, chest.Trait{ID: trait.ID, Intensity: trait.Intensity, Seed: trait.Seed})
		}
		if x.Drop != nil {
			record.State.Drop = &chest.Drop{Item: x.Drop.Item, State: x.Drop.Condition}
		}
		if x.OpenedAt != nil {
			at, err := time.Parse(time.RFC3339Nano, *x.OpenedAt)
			if err != nil {
				return r, &v1.Error{Code: v1.Invalid}
			}
			record.OpenedAt = &at
		}
		if x.Reward != nil {
			v := x.Reward
			record.Reward = &domain.Item{ID: v.ID, Owner: v.Owner, Definition: v.Definition, Condition: v.Condition, Origin: v.Origin, Status: domain.Available}
		}
		r.Chests = append(r.Chests, record)
	}
	return r, nil
}
