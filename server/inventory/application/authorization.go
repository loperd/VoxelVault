package application

import (
	"context"
	"errors"

	"github.com/voxel-vault/api/inventory/domain"
)

var ErrForbidden = errors.New("inventory permission denied")
var ErrAuthorizationUnavailable = errors.New("inventory authorization unavailable")

type Permission string

const (
	ReadItems          Permission = "inventory.items.read"
	ReadChests         Permission = "inventory.chests.read"
	IssueChests        Permission = "inventory.chests.issue"
	GrantStarter       Permission = "inventory.starter.grant"
	ClaimChest         Permission = "inventory.chest.claim"
	OpenChest          Permission = "inventory.chest.open"
	MergeChests        Permission = "inventory.chests.merge"
	ReadMergeOdds      Permission = "inventory.chests.odds"
	MergeItems         Permission = "inventory.items.merge"
	RepairItem         Permission = "inventory.item.repair"
	SellItem           Permission = "inventory.item.sell"
	SalvageItem        Permission = "inventory.item.salvage"
	ReadOperation      Permission = "inventory.operation.read"
	CancelOperation    Permission = "inventory.operation.cancel"
	ObserveSettlement  Permission = "inventory.settlement.observe"
	ReconcileOperation Permission = "inventory.operation.reconcile"
	ExecuteDelivery    Permission = "inventory.delivery.execute"
	ImportItems        Permission = "inventory.baseline.items.import"
	ImportChests       Permission = "inventory.baseline.chests.import"
)

type Principal struct{ Kind, ID string }
type Resource struct{ Kind, ID, Owner, Source, Version string }
type AccessRequest struct {
	Principal      Principal
	Permission     Permission
	Resource       Resource
	OperationScope string
}
type Decision struct{ PolicyVersion string }
type Authorizer interface {
	Authorize(context.Context, AccessRequest) (Decision, error)
}
type principalKey struct{}
type operationScopeKey struct{}
type decisionKey struct{}
type authorizationEvidence struct {
	Permission Permission
	Version    string
}

// Authentication belongs to the trusted inbound adapter. This function carries
// its verified identity, never roles or permissions taken from command payloads.
func WithAuthenticatedPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}
func WithOperationScope(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, operationScopeKey{}, id)
}
func authorize(ctx context.Context, auth Authorizer, permission Permission, resource Resource) (context.Context, error) {
	if err := ctx.Err(); err != nil {
		return ctx, err
	}
	p, ok := ctx.Value(principalKey{}).(Principal)
	if !ok || !domain.ValidID(p.ID) || (p.Kind != "user" && p.Kind != "service" && p.Kind != "operator") || auth == nil {
		return ctx, ErrForbidden
	}
	if !domain.ValidID(resource.ID) || !domain.ValidID(resource.Kind) {
		return ctx, domain.ErrInvalid
	}
	scope, _ := ctx.Value(operationScopeKey{}).(string)
	decision, err := auth.Authorize(ctx, AccessRequest{Principal: p, Permission: permission, Resource: resource, OperationScope: scope})
	if err != nil {
		if errors.Is(err, ErrForbidden) {
			return ctx, ErrForbidden
		}
		return ctx, ErrAuthorizationUnavailable
	}
	if !domain.ValidID(decision.PolicyVersion) {
		return ctx, ErrAuthorizationUnavailable
	}
	ctx = context.WithValue(ctx, decisionKey{}, authorizationEvidence{Permission: permission, Version: decision.PolicyVersion})
	return ctx, nil
}
