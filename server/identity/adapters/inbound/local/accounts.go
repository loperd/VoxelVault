package local

import (
	"context"

	"github.com/voxel-vault/api/identity/application"
	v1 "github.com/voxel-vault/api/identity/contracts/v1"
)

type Accounts struct {
	Service   application.Accounts
	Principal application.Principal
}

func (c Accounts) ctx(ctx context.Context) context.Context {
	return application.WithAuthenticatedPrincipal(ctx, c.Principal)
}
func provider(p v1.ProviderIdentity) application.ProviderIdentity {
	return application.ProviderIdentity{Provider: p.Provider, ExternalID: p.ExternalID, Username: p.Username, DisplayName: p.DisplayName}
}
func (c Accounts) Resolve(ctx context.Context, p v1.ProviderIdentity) (string, error) {
	v, err := c.Service.Resolve(c.ctx(ctx), provider(p))
	return v, publicError(err)
}
func (c Accounts) Link(ctx context.Context, input v1.LinkRequest) (string, error) {
	v, err := c.Service.Link(c.ctx(ctx), application.LinkRequest{Subject: input.UserID, SessionID: input.SessionID, Scopes: append([]string(nil), input.Scopes...), Identity: provider(input.Identity)})
	return v, publicError(err)
}
func (c Accounts) Permissions(ctx context.Context, id string) ([]string, error) {
	v, err := c.Service.Permissions(c.ctx(ctx), id)
	return v, publicError(err)
}
func (c Accounts) Catalog(ctx context.Context) ([]string, error) {
	v, err := c.Service.Catalog(c.ctx(ctx))
	return v, publicError(err)
}

func (c Accounts) Profile(ctx context.Context, id string) (v1.Profile, error) {
	p, e := c.Service.Profile(c.ctx(ctx), id)
	return v1.Profile{ID: p.ID, Handle: p.Handle, DisplayName: p.DisplayName}, publicError(e)
}
func (c Accounts) Exists(ctx context.Context, id string) (bool, error) {
	v, e := c.Service.Exists(c.ctx(ctx), id)
	return v, publicError(e)
}

func (c Accounts) ResolveRecipient(ctx context.Context, query string) (v1.Profile, error) {
	p, err := c.Service.ResolveRecipient(c.ctx(ctx), query)
	return v1.Profile{ID: p.ID, Handle: p.Handle, DisplayName: p.DisplayName}, publicError(err)
}
