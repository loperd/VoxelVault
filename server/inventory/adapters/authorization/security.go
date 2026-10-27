package authorization

import (
	"context"
	"github.com/voxel-vault/api/inventory/application"
	v1 "github.com/voxel-vault/api/security/contracts/v1"
)

type Security struct{ Client v1.Client }

func (a Security) Authorize(ctx context.Context, r application.AccessRequest) (application.Decision, error) {
	if a.Client == nil {
		return application.Decision{}, application.ErrAuthorizationUnavailable
	}
	d, err := a.Client.Decide(ctx, v1.Request{ActorKind: r.Principal.Kind, ActorID: r.Principal.ID, Permission: string(r.Permission), Context: "inventory", ResourceKind: r.Resource.Kind, ResourceID: r.Resource.ID, Owner: r.Resource.Owner, Source: r.Resource.Source, Version: r.Resource.Version, OperationScope: r.OperationScope})
	if err != nil {
		return application.Decision{}, err
	}
	if !d.Allowed {
		return application.Decision{}, application.ErrForbidden
	}
	return application.Decision{PolicyVersion: d.PolicyVersion}, nil
}
