package application

import (
	"context"
	"encoding/hex"

	"github.com/voxel-vault/api/inventory/domain"
)

type Opening struct {
	Source, Digest string
	Items          []domain.Item
}
type OpeningStore interface {
	ImportItems(context.Context, Opening) error
}
type OpeningService struct {
	Store      OpeningStore
	Authorizer Authorizer
}

func (s OpeningService) Import(ctx context.Context, input Opening) error {
	var authorizationErr error
	ctx, authorizationErr = authorize(ctx, s.Authorizer, ImportItems, Resource{Kind: "baseline", ID: input.Source, Source: input.Source, Version: input.Digest})
	if authorizationErr != nil {
		return authorizationErr
	}
	digest, err := hex.DecodeString(input.Digest)
	if s.Store == nil || !domain.ValidID(input.Source) || err != nil || len(digest) != 32 || hex.EncodeToString(digest) != input.Digest {
		return domain.ErrInvalid
	}
	input.Items = append([]domain.Item(nil), input.Items...)
	seen := map[string]bool{}
	for _, item := range input.Items {
		if err := domain.ValidateOpeningItem(item); err != nil {
			return err
		}
		if seen[item.ID] {
			return domain.ErrConflict
		}
		seen[item.ID] = true
	}
	return s.Store.ImportItems(withLifecycle(ctx, "opening_baseline", input.Digest, map[string]string{"source": input.Source, "digest": input.Digest}), input)
}
