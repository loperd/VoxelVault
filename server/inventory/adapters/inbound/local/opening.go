package local

import (
	"context"
	"errors"

	"github.com/voxel-vault/api/inventory/application"
	v1 "github.com/voxel-vault/api/inventory/contracts/v1"
	"github.com/voxel-vault/api/inventory/domain"
	"github.com/voxel-vault/api/inventory/domain/chest"
)

type OpeningClient struct{ Service application.OpeningService }

func (c OpeningClient) ImportItems(ctx context.Context, in v1.Opening) error {
	r := application.Opening{Source: in.Source, Digest: in.Digest}
	for _, item := range in.Items {
		r.Items = append(r.Items, domain.Item{ID: item.ID, Owner: item.Owner, Definition: item.Definition, Condition: item.Condition, Origin: item.Origin, Status: domain.Available})
	}
	return publicError(c.Service.Import(ctx, r))
}

func publicError(err error) error {
	if err == nil {
		return nil
	}
	code := v1.Unavailable
	switch {
	case errors.Is(err, application.ErrForbidden):
		code = v1.Forbidden
	case errors.Is(err, domain.ErrInvalid):
		code = v1.Invalid
	case errors.Is(err, domain.ErrConflict), errors.Is(err, domain.ErrBusy), errors.Is(err, chest.ErrUnavailable), errors.Is(err, chest.ErrNotOpening), errors.Is(err, chest.ErrWrongSession), errors.Is(err, chest.ErrMismatch):
		code = v1.Conflict
	case errors.Is(err, domain.ErrNotFound), errors.Is(err, chest.ErrUnknownType):
		code = v1.NotFound
	case errors.Is(err, chest.ErrNoSession):
		code = v1.Invalid
	}
	return &v1.Error{Code: code}
}
