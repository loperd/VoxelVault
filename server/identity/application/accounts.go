package application

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/voxel-vault/api/identity/domain"
)

var ErrConflict = errors.New("identity registration conflict")

type ProviderIdentity struct{ Provider, ExternalID, Username, DisplayName string }
type Registration struct {
	ID, Subject string
	Pending     bool
}
type RoleReceipt struct{ CommandID, Subject, Role, PolicyVersion string }
type Roles interface {
	Register(context.Context, string, string) (RoleReceipt, error)
	Permissions(context.Context, string) ([]string, error)
	Catalog(context.Context) ([]string, error)
	Allowed(context.Context, string, string, string) (bool, error)
}
type Registry interface {
	Directory
	Resolve(context.Context, ProviderIdentity, string, time.Time, Cause) (Registration, error)
	Link(context.Context, string, ProviderIdentity, time.Time, Cause) (string, error)
	Complete(context.Context, Registration, RoleReceipt, time.Time, Cause) error
	Pending(context.Context, time.Time, int) ([]Registration, error)
	Failed(context.Context, Registration, bool, time.Time, Cause) error
}
type SessionValidator interface {
	Validate(context.Context, string, string) error
}
type LinkRequest struct {
	Subject, SessionID string
	Scopes             []string
	Identity           ProviderIdentity
}
type Accounts struct {
	Grants     func(grants []string, action, resource string) bool
	Sessions   SessionValidator
	Profiles   ProfileReader
	Recipient  RecipientReader
	Registry   Registry
	Roles      Roles
	Authorizer Authorizer
	Clock      func() time.Time
	ID         func() (string, error)
	Providers  []string
}

func (a Accounts) access(ctx context.Context, permission, kind, id string) (Cause, error) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	if !ok || p.Kind != "service" || !domain.ValidID(p.ID) || a.Registry == nil || a.Roles == nil || a.Authorizer == nil {
		return Cause{}, domain.ErrForbidden
	}
	d, err := a.Authorizer.Authorize(ctx, Access{Principal: p, Permission: permission, ResourceKind: kind, ResourceID: id, Owner: p.ID})
	if err != nil {
		return Cause{}, err
	}
	if !domain.ValidID(d.PolicyVersion) {
		return Cause{}, domain.ErrForbidden
	}
	return Cause{Actor: p.ID, PolicyVersion: d.PolicyVersion}, nil
}
func (a Accounts) provider(p ProviderIdentity) bool {
	allowed := false
	for _, v := range a.Providers {
		if v == p.Provider {
			allowed = true
			break
		}
	}
	if !allowed || !domain.ValidID(p.Provider) || len(p.Provider) > 32 || !domain.ValidID(p.ExternalID) || !domain.SafeProfileText(p.DisplayName, 160) || !domain.SafeProfileText(p.Username, 160) {
		return false
	}
	return true
}
func (a Accounts) now() (time.Time, error) {
	if a.Clock == nil {
		return time.Time{}, domain.ErrInvalid
	}
	at := a.Clock().UTC()
	if at.IsZero() {
		return at, domain.ErrInvalid
	}
	return at, nil
}
func (a Accounts) Resolve(ctx context.Context, p ProviderIdentity) (string, error) {
	if !a.provider(p) {
		return "", domain.ErrInvalid
	}
	cause, err := a.access(ctx, "identity.provider.resolve", "provider", p.Provider)
	if err != nil {
		return "", err
	}
	at, err := a.now()
	if err != nil {
		return "", err
	}
	if a.ID == nil {
		return "", domain.ErrInvalid
	}
	id, err := a.ID()
	if err != nil {
		return "", err
	}
	if !domain.ValidID(id) {
		return "", domain.ErrInvalid
	}
	p.DisplayName = strings.TrimSpace(p.DisplayName)
	if p.DisplayName == "" {
		p.DisplayName = "Player"
	}
	r, err := a.Registry.Resolve(ctx, p, id, at, cause)
	if err != nil {
		return "", err
	}
	if err = a.finish(ctx, r, cause); err != nil {
		return "", err
	}
	return r.Subject, nil
}
func (a Accounts) finish(ctx context.Context, r Registration, cause Cause) error {
	if !domain.ValidID(r.Subject) || r.Pending && !domain.ValidID(r.ID) {
		return domain.ErrInvalid
	}
	if !r.Pending {
		return nil
	}
	receipt, err := a.Roles.Register(ctx, r.ID, r.Subject)
	if err != nil {
		return a.failed(ctx, r, cause, err)
	}
	if receipt.CommandID != r.ID || receipt.Subject != r.Subject || !domain.ValidID(receipt.Role) || !domain.ValidID(receipt.PolicyVersion) {
		return a.failed(ctx, r, cause, ErrConflict)
	}
	at, err := a.now()
	if err != nil {
		return err
	}
	if err := a.Registry.Complete(ctx, r, receipt, at, cause); err != nil {
		return a.failed(ctx, r, cause, err)
	}
	return nil
}
func (a Accounts) failed(ctx context.Context, r Registration, cause Cause, original error) error {
	at, err := a.now()
	if err != nil {
		return errors.Join(original, err)
	}
	err = a.Registry.Failed(ctx, r, errors.Is(original, ErrConflict), at, cause)
	return errors.Join(original, err)
}
func (a Accounts) Link(ctx context.Context, input LinkRequest) (string, error) {
	subject, p := input.Subject, input.Identity
	if !domain.ValidID(subject) || !a.provider(p) {
		return "", domain.ErrInvalid
	}
	cause, err := a.access(ctx, "identity.provider.link", "account", subject)
	if err != nil {
		return "", err
	}
	if a.Sessions == nil || !domain.ValidID(input.SessionID) || !a.Grants(input.Scopes, "LINK", "/identity/accounts/"+subject) {
		return "", domain.ErrForbidden
	}
	if err := a.Sessions.Validate(ctx, input.SessionID, subject); err != nil {
		return "", err
	}
	allowed, err := a.Roles.Allowed(ctx, subject, "/identity/accounts/"+subject, "LINK")
	if err != nil {
		return "", err
	}
	if !allowed {
		return "", domain.ErrForbidden
	}
	at, err := a.now()
	if err != nil {
		return "", err
	}
	return a.Registry.Link(ctx, subject, p, at, cause)
}
func (a Accounts) Permissions(ctx context.Context, subject string) ([]string, error) {
	if !domain.ValidID(subject) {
		return nil, domain.ErrInvalid
	}
	if _, err := a.access(ctx, "identity.permissions.read", "account", subject); err != nil {
		return nil, err
	}
	exists, err := a.Registry.Exists(ctx, subject)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, domain.ErrUnauthenticated
	}
	return a.Roles.Permissions(ctx, subject)
}
func (a Accounts) Catalog(ctx context.Context) ([]string, error) {
	if _, err := a.access(ctx, "identity.permissions.catalog", "catalog", "permission-catalog"); err != nil {
		return nil, err
	}
	return a.Roles.Catalog(ctx)
}

// ResumePending recovers committed registrations independently of browser retries.
// The remote grant is idempotent; duplicate workers need no cross-context lock.
func (a Accounts) ResumePending(ctx context.Context, limit int) (int, error) {
	if limit < 1 || limit > 100 {
		return 0, domain.ErrInvalid
	}
	cause, err := a.access(ctx, "identity.registration.resume", "registrations", "pending")
	if err != nil {
		return 0, err
	}
	at, err := a.now()
	if err != nil {
		return 0, err
	}
	items, err := a.Registry.Pending(ctx, at, limit)
	if err != nil {
		return 0, err
	}
	var failures []error
	for _, r := range items {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		if err := a.finish(ctx, r, cause); err != nil {
			failures = append(failures, err)
		}
	}
	return len(items), errors.Join(failures...)
}
