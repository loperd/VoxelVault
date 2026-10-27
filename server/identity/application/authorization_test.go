package application_test

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"

	"github.com/voxel-vault/api/identity/application"
	"github.com/voxel-vault/api/identity/domain"
)

type denied struct{ failure error }

func (d denied) Authorize(context.Context, application.Access) (application.Decision, error) {
	return application.Decision{}, d.failure
}

type untouched struct{ t *testing.T }

func (u untouched) Read(context.Context, string) (domain.Session, error) {
	u.t.Fatal("denied request read session")
	return domain.Session{}, nil
}

func (u untouched) Exists(context.Context, string) (bool, error) {
	u.t.Fatal("denied request read account registry")
	return false, nil
}
func (u untouched) Create(context.Context, domain.Session, application.Event) error {
	u.t.Fatal("denied request created session")
	return nil
}
func (u untouched) Transact(context.Context, string, func(application.Tx) error) error {
	u.t.Fatal("denied request opened transaction")
	return nil
}
func TestAllSessionEntrypointsAuthorizeBeforeIO(t *testing.T) {
	ctx := application.WithAuthenticatedPrincipal(context.Background(), application.Principal{Kind: "service", ID: "gateway"})
	offline := errors.New("Security unavailable")
	for _, failure := range []error{domain.ErrForbidden, offline, nil} {
		s := application.Service{Store: untouched{t}, Directory: untouched{t}, Authorizer: denied{failure}}
		_, err := s.Issue(ctx, application.Issue{Subject: "alice", TTLSeconds: 60})
		if err == nil {
			t.Fatal("unauthorized issue")
		}
		_, err = s.Refresh(ctx, "session", base64.RawURLEncoding.EncodeToString(make([]byte, 32)))
		if err == nil {
			t.Fatal("unauthorized refresh")
		}
		if err = s.Revoke(ctx, "session"); err == nil {
			t.Fatal("unauthorized revoke")
		}
		if err = s.Validate(ctx, "session", "alice"); err == nil {
			t.Fatal("unauthorized session validation")
		}
	}
}
