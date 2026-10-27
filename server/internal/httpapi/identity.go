package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	iv1 "github.com/voxel-vault/api/identity/contracts/v1"
	"github.com/voxel-vault/api/platform/gatewayhttp"
	"github.com/voxel-vault/api/platform/resourcegrants"
	sv1 "github.com/voxel-vault/api/security/contracts/v1"
)

type User struct{ ID, Handle, DisplayName string }
type IdentityPorts struct {
	Peer     *gatewayhttp.Peer
	Profiles iv1.Profiles
	Sessions iv1.Sessions
	Security sv1.Subjects
}

func singleHeader(r *http.Request, name string) string {
	values := r.Header.Values(name)
	if len(values) != 1 || values[0] == "" || len(values[0]) > 160 || strings.TrimSpace(values[0]) != values[0] || strings.ContainsAny(values[0], "\x00\r\n,") {
		return ""
	}
	return values[0]
}
func (s *Server) gatewayUser(r *http.Request) (User, error) {
	p := s.identity
	if p == nil || !p.Peer.Trusted(r) {
		return User{}, fmt.Errorf("untrusted peer")
	}
	id, sid := singleHeader(r, "X-User-Id"), singleHeader(r, "X-Session-Id")
	if id == "" || sid == "" {
		return User{}, fmt.Errorf("missing principal")
	}
	if err := p.Sessions.Validate(r.Context(), sid, id); err != nil {
		return User{}, err
	}
	profile, err := p.Profiles.Profile(r.Context(), id)
	if err != nil || profile.ID != id {
		return User{}, fmt.Errorf("account unavailable")
	}
	return User{ID: id, Handle: profile.Handle, DisplayName: profile.DisplayName}, nil
}

// Token grants cap delegated access; current context permissions may further shrink it.
func (p *IdentityPorts) Allowed(ctx context.Context, r *http.Request, id, action string) (bool, error) {
	if !p.Peer.Trusted(r) {
		return false, nil
	}
	scopes := r.Header.Values("X-Scopes")
	if len(scopes) != 1 || len(scopes[0]) > 65536 {
		return false, nil
	}
	if !resourcegrants.Allows(strings.Split(scopes[0], ","), action, r.URL.Path) {
		return false, nil
	}
	return p.Security.Check(ctx, sv1.PermissionCheck{Subject: id, Resource: r.URL.Path, Action: action})
}
