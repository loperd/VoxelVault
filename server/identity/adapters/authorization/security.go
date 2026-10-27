package authorization

import (
	"context"
	"fmt"

	"github.com/voxel-vault/api/identity/application"
	"github.com/voxel-vault/api/identity/domain"
	v1 "github.com/voxel-vault/api/security/contracts/v1"
)

type Security struct{ Client v1.Client }

func (a Security) Authorize(ctx context.Context, r application.Access) (application.Decision, error) {
	if a.Client == nil {
		return application.Decision{}, domain.ErrForbidden
	}
	d, err := a.Client.Decide(ctx, v1.Request{Context: "identity", ActorKind: r.Principal.Kind, ActorID: r.Principal.ID, Permission: r.Permission, ResourceKind: r.ResourceKind, ResourceID: r.ResourceID, Owner: r.Principal.ID, Source: r.Principal.ID})
	if err != nil {
		return application.Decision{}, fmt.Errorf("identity authorization unavailable: %w", err)
	}
	if !d.Allowed {
		return application.Decision{}, domain.ErrForbidden
	}
	return application.Decision{PolicyVersion: d.PolicyVersion}, nil
}
