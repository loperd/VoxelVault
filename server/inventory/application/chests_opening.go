package application

import (
	"context"
	"encoding/hex"
	"time"

	"github.com/voxel-vault/api/inventory/domain"
)

type OpeningOwner struct {
	ID               string
	StarterGrantedAt *time.Time
}
type ChestsOpening struct {
	Source, Digest string
	Owners         []OpeningOwner
	Chests         []domain.StoredChest
}
type ChestsOpeningStore interface {
	ImportChests(context.Context, ChestsOpening) error
}
type ChestsOpeningService struct {
	Store      ChestsOpeningStore
	Authorizer Authorizer
}

func (s ChestsOpeningService) Import(ctx context.Context, r ChestsOpening) error {
	var authorizationErr error
	ctx, authorizationErr = authorize(ctx, s.Authorizer, ImportChests, Resource{Kind: "baseline", ID: r.Source, Source: r.Source, Version: r.Digest})
	if authorizationErr != nil {
		return authorizationErr
	}
	if s.Store == nil {
		return domain.ErrInvalid
	}
	if err := ValidateChestsOpening(r); err != nil {
		return err
	}
	r.Owners = append([]OpeningOwner(nil), r.Owners...)
	for i, o := range r.Owners {
		if o.StarterGrantedAt != nil {
			at := *o.StarterGrantedAt
			r.Owners[i].StarterGrantedAt = &at
		}
	}
	r.Chests = append([]domain.StoredChest(nil), r.Chests...)
	for i, c := range r.Chests {
		r.Chests[i] = c.Clone()
	}
	return s.Store.ImportChests(withLifecycle(ctx, "opening_baseline", r.Digest, map[string]string{"source": r.Source, "digest": r.Digest}), r)
}

// ValidateChestsOpening is a pure preflight: it performs no storage or transport calls.
func ValidateChestsOpening(r ChestsOpening) error {
	digest, err := hex.DecodeString(r.Digest)
	if !domain.ValidID(r.Source) || err != nil || len(digest) != 32 || hex.EncodeToString(digest) != r.Digest {
		return domain.ErrInvalid
	}
	owners := map[string]bool{}
	for _, o := range r.Owners {
		if !domain.ValidID(o.ID) || owners[o.ID] || (o.StarterGrantedAt != nil && o.StarterGrantedAt.IsZero()) {
			return domain.ErrInvalid
		}
		owners[o.ID] = true
	}
	seen := map[string]bool{}
	for _, c := range r.Chests {
		if err := domain.ValidateChest(c); err != nil {
			return err
		}
		if !owners[c.State.Owner] || seen[c.State.ID] {
			return domain.ErrConflict
		}
		seen[c.State.ID] = true
	}
	return nil
}
