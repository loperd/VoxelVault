package local

import (
	"context"
	"errors"

	"github.com/voxel-vault/api/internal/currency/application"
	v1 "github.com/voxel-vault/api/internal/currency/contracts/v1"
)

type Provider struct {
	Catalog  *application.Catalog
	Producer string
}

func publicError(err error) error {
	switch {
	case errors.Is(err, application.ErrInvalid):
		return &v1.Error{Code: "invalid"}
	case errors.Is(err, application.ErrForbidden):
		return &v1.Error{Code: "forbidden"}
	default:
		return err
	}
}

func descriptor(d application.Descriptor) v1.Descriptor {
	return v1.Descriptor{
		ID:        d.ID,
		Code:      d.Code,
		Name:      d.Name,
		Precision: d.Precision,
		Revision:  d.Revision,
		Active:    d.Active,
	}
}

func (c Provider) Describe(ctx context.Context, id string) (v1.Descriptor, error) {
	d, err := c.Catalog.Describe(ctx, c.Producer, id)
	return descriptor(d), publicError(err)
}

func (c Provider) Decide(ctx context.Context, subject, id string) (v1.AccessDecision, error) {
	d, err := c.Catalog.Decide(ctx, c.Producer, subject, id)
	return v1.AccessDecision{
		CanRead:    d.CanRead,
		CanOperate: d.CanOperate,
		Revision:   d.Revision,
	}, publicError(err)
}

func (c Provider) List(ctx context.Context, subject string) ([]v1.Descriptor, error) {
	d, err := c.Catalog.List(ctx, c.Producer, subject)
	if err != nil {
		return nil, publicError(err)
	}
	result := []v1.Descriptor{}
	for _, v := range d {
		result = append(result, descriptor(v))
	}
	return result, nil
}
