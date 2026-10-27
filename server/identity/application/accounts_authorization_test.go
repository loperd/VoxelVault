package application_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/voxel-vault/api/identity/application"
	"github.com/voxel-vault/api/identity/domain"
)

type accountIO struct{ untouched }

func (a accountIO) Resolve(context.Context, application.ProviderIdentity, string, time.Time, application.Cause) (application.Registration, error) {
	a.t.Fatal("unauthorized account creation")
	return application.Registration{}, nil
}
func (a accountIO) Link(context.Context, string, application.ProviderIdentity, time.Time, application.Cause) (string, error) {
	a.t.Fatal("unauthorized provider link")
	return "", nil
}
func (a accountIO) Complete(context.Context, application.Registration, application.RoleReceipt, time.Time, application.Cause) error {
	a.t.Fatal("unauthorized registration completion")
	return nil
}
func (a accountIO) Pending(context.Context, time.Time, int) ([]application.Registration, error) {
	a.t.Fatal("unauthorized registration scan")
	return nil, nil
}
func (a accountIO) Failed(context.Context, application.Registration, bool, time.Time, application.Cause) error {
	a.t.Fatal("unauthorized registration update")
	return nil
}
func (a accountIO) Register(context.Context, string, string) (application.RoleReceipt, error) {
	a.t.Fatal("unauthorized Security command")
	return application.RoleReceipt{}, nil
}
func (a accountIO) Permissions(context.Context, string) ([]string, error) {
	a.t.Fatal("unauthorized permission read")
	return nil, nil
}
func (a accountIO) Catalog(context.Context) ([]string, error) {
	a.t.Fatal("unauthorized catalog read")
	return nil, nil
}
func (a accountIO) Allowed(context.Context, string, string, string) (bool, error) {
	a.t.Fatal("unauthorized role check")
	return false, nil
}
func TestAccountEntrypointsDenyBeforePersistenceOrSecurityCalls(t *testing.T) {
	io := accountIO{untouched{t}}
	a := application.Accounts{Registry: io, Roles: io, Authorizer: denied{domain.ErrForbidden}, Providers: []string{"telegram"}, Clock: time.Now, ID: func() (string, error) { return "new-account", nil }}
	for _, ctx := range []context.Context{context.Background(), application.WithAuthenticatedPrincipal(context.Background(), application.Principal{Kind: "service", ID: "gateway"}), application.WithAuthenticatedPrincipal(context.Background(), application.Principal{Kind: "user", ID: "gateway"})} {
		if _, err := a.Resolve(ctx, application.ProviderIdentity{Provider: "telegram", ExternalID: "subject"}); !errors.Is(err, domain.ErrForbidden) {
			t.Fatal("resolve was allowed")
		}
		if _, err := a.Link(ctx, application.LinkRequest{Subject: "alice", Identity: application.ProviderIdentity{Provider: "telegram", ExternalID: "subject"}}); !errors.Is(err, domain.ErrForbidden) {
			t.Fatal("link was allowed")
		}
		if _, err := a.Permissions(ctx, "alice"); !errors.Is(err, domain.ErrForbidden) {
			t.Fatal("permissions were allowed")
		}
		if _, err := a.Catalog(ctx); !errors.Is(err, domain.ErrForbidden) {
			t.Fatal("catalog was allowed")
		}
		if _, err := a.ResumePending(ctx, 64); !errors.Is(err, domain.ErrForbidden) {
			t.Fatal("recovery was allowed")
		}
	}
}
