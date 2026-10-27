package local

import (
	"context"
	"errors"

	"github.com/voxel-vault/api/identity/application"
	v1 "github.com/voxel-vault/api/identity/contracts/v1"
	"github.com/voxel-vault/api/identity/domain"
)

type Sessions struct {
	Service   application.Service
	Principal application.Principal
}

func (c Sessions) ctx(ctx context.Context) context.Context {
	return application.WithAuthenticatedPrincipal(ctx, c.Principal)
}
func (c Sessions) Issue(ctx context.Context, r v1.Issue) (v1.Issued, error) {
	v, err := c.Service.Issue(c.ctx(ctx), application.Issue{Subject: r.UserID, UserAgent: r.UserAgent, IP: r.IP, TTLSeconds: r.TTLSeconds})
	return v1.Issued{SessionID: v.SessionID, RefreshJTI: v.RefreshToken}, publicError(err)
}
func (c Sessions) Refresh(ctx context.Context, id, token string) (v1.Refreshed, error) {
	v, err := c.Service.Refresh(c.ctx(ctx), id, token)
	return v1.Refreshed{UserID: v.Subject, RefreshJTI: v.RefreshToken}, publicError(err)
}
func (c Sessions) Revoke(ctx context.Context, id string) error {
	return publicError(c.Service.Revoke(c.ctx(ctx), id))
}
func (c Sessions) Validate(ctx context.Context, id, subject string) error {
	return publicError(c.Service.Validate(c.ctx(ctx), id, subject))
}
func publicError(err error) error {
	if err == nil {
		return nil
	}
	code := "unavailable"
	switch {
	case errors.Is(err, domain.ErrInvalid):
		code = "invalid"
	case errors.Is(err, domain.ErrUnauthenticated):
		code = "unauthenticated"
	case errors.Is(err, domain.ErrForbidden):
		code = "forbidden"
	case errors.Is(err, application.ErrConflict):
		code = "conflict"
	}
	return &v1.Error{Code: code}
}
