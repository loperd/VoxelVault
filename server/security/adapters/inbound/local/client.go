package local

import (
	"context"
	"github.com/voxel-vault/api/security/application"
	v1 "github.com/voxel-vault/api/security/contracts/v1"
)

type Client struct{ Service *application.Service }

func (c Client) Decide(ctx context.Context, r v1.Request) (v1.Decision, error) {
	if c.Service == nil {
		return v1.Decision{}, application.ErrInvalid
	}
	d, err := c.Service.Decide(ctx, application.Request{Actor: application.Actor{Kind: r.ActorKind, ID: r.ActorID}, Permission: r.Permission, Context: r.Context, ResourceKind: r.ResourceKind, ResourceID: r.ResourceID, Owner: r.Owner, Source: r.Source, Version: r.Version, OperationScope: r.OperationScope, Attributes: r.Attributes})
	return v1.Decision{Allowed: d.Allowed, PolicyVersion: d.PolicyVersion}, err
}
