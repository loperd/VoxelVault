package application

import (
	"context"
	"encoding/json"

	"github.com/voxel-vault/api/inventory/domain"
)

// LifecycleCause is audit evidence, not authorization. The application supplies
// command data; PostgreSQL independently records the authenticated database role.
type LifecycleCause struct {
	Kind          string          `json:"kind"`
	ID            string          `json:"id"`
	Payload       json.RawMessage `json:"payload"`
	Initiator     string          `json:"initiator,omitempty"`
	Permission    string          `json:"permission,omitempty"`
	PolicyVersion string          `json:"policyVersion,omitempty"`
}
type lifecycleKey struct{}
type lifecycleInitiatorKey struct{}

// WithLifecycleInitiator is supplied by the authenticated inbound adapter. This
// audit attribution does not grant permissions or replace an authorization port.
func WithLifecycleInitiator(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, lifecycleInitiatorKey{}, id)
}

func withLifecycle(ctx context.Context, kind, id string, input any) context.Context {
	b, _ := json.Marshal(input)
	actor, _ := ctx.Value(lifecycleInitiatorKey{}).(string)
	if principal, ok := ctx.Value(principalKey{}).(Principal); ok {
		actor = principal.ID
	}
	decision, _ := ctx.Value(decisionKey{}).(authorizationEvidence)
	return context.WithValue(ctx, lifecycleKey{}, LifecycleCause{Kind: kind, ID: id, Payload: b, Initiator: actor, Permission: string(decision.Permission), PolicyVersion: decision.Version})
}

func LifecycleFromContext(ctx context.Context) (LifecycleCause, bool) {
	c, ok := ctx.Value(lifecycleKey{}).(LifecycleCause)
	return c, ok && domain.ValidID(c.Kind) && domain.ValidID(c.ID) && json.Valid(c.Payload)
}
