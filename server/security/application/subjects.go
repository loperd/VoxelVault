package application

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

var ErrForbidden = errors.New("security subject permission denied")
var ErrConflict = errors.New("security registration conflicts with existing receipt")

type SubjectRegistration struct{ CommandID, Subject string }
type SubjectReceipt struct {
	CommandID, Subject, Role, PolicyVersion, Actor string
	At                                             time.Time
}
type Permission struct {
	Resource string `json:"resource"`
	Action   string `json:"action"`
}
type SubjectStore interface {
	Register(context.Context, SubjectReceipt) (SubjectReceipt, error)
	Roles(context.Context, string) ([]string, error)
}
type Decisions interface {
	Decide(context.Context, Request) (Decision, error)
}
type SubjectService struct {
	Store       SubjectStore
	Authorizer  Decisions
	DefaultRole string
	Clock       func() time.Time
	Policy      *RolePolicy
}

func (s SubjectService) Check(ctx context.Context, subject, resource, action string) (bool, error) {
	if !validID(subject) || !validText(resource, 2048) || !validID(action) || s.Policy == nil {
		return false, ErrInvalid
	}
	if _, _, err := s.authorize(ctx, "security.permissions.check", subject); err != nil {
		return false, err
	}
	roles, err := s.Store.Roles(ctx, subject)
	if err != nil {
		return false, err
	}
	return s.Policy.Allows(roles, resource, action), nil
}

type actorKey struct{}

func WithAuthenticatedActor(ctx context.Context, a Actor) context.Context {
	return context.WithValue(ctx, actorKey{}, a)
}
func validID(id string) bool {
	return validText(id, 160)
}
func validText(value string, maximum int) bool {
	return value != "" && len(value) <= maximum && utf8.ValidString(value) && strings.TrimSpace(value) == value && !strings.ContainsAny(value, "\x00\r\n")
}
func (s SubjectService) authorize(ctx context.Context, permission, resource string) (Actor, Decision, error) {
	a, ok := ctx.Value(actorKey{}).(Actor)
	if !ok || a.Kind != "service" || !validID(a.ID) || s.Store == nil || s.Authorizer == nil {
		return a, Decision{}, ErrForbidden
	}
	d, err := s.Authorizer.Decide(ctx, Request{Actor: a, Context: "security", Permission: permission, ResourceKind: "subject", ResourceID: resource, Owner: resource, Source: a.ID})
	if err != nil {
		return a, d, err
	}
	if !d.Allowed || !validID(d.PolicyVersion) {
		return a, d, ErrForbidden
	}
	return a, d, nil
}
func (s SubjectService) Register(ctx context.Context, r SubjectRegistration) (SubjectReceipt, error) {
	if !validID(r.CommandID) || !validID(r.Subject) || !validID(s.DefaultRole) || !s.Policy.HasRole(s.DefaultRole) || s.Clock == nil {
		return SubjectReceipt{}, ErrInvalid
	}
	a, d, err := s.authorize(ctx, "security.subject.register", r.Subject)
	if err != nil {
		return SubjectReceipt{}, err
	}
	at := s.Clock().UTC()
	if at.IsZero() {
		return SubjectReceipt{}, ErrInvalid
	}
	return s.Store.Register(ctx, SubjectReceipt{CommandID: r.CommandID, Subject: r.Subject, Role: s.DefaultRole, Actor: a.ID, PolicyVersion: d.PolicyVersion + "/" + s.Policy.version, At: at})
}
func (s SubjectService) Permissions(ctx context.Context, subject string) ([]Permission, error) {
	if !validID(subject) {
		return nil, ErrInvalid
	}
	if _, _, err := s.authorize(ctx, "security.permissions.read", subject); err != nil {
		return nil, err
	}
	roles, err := s.Store.Roles(ctx, subject)
	if err != nil {
		return nil, err
	}
	if s.Policy == nil {
		return nil, ErrInvalid
	}
	return s.Policy.Permissions(roles), nil
}
func (s SubjectService) Catalog(ctx context.Context) ([]Permission, error) {
	if _, _, err := s.authorize(ctx, "security.permissions.catalog", "permission-catalog"); err != nil {
		return nil, err
	}
	if s.Policy == nil {
		return nil, ErrInvalid
	}
	return s.Policy.Catalog(), nil
}

func (s SubjectService) Roles(ctx context.Context, id string) ([]string, error) {
	if !validID(id) {
		return nil, ErrInvalid
	}
	if _, _, err := s.authorize(ctx, "security.permissions.read", id); err != nil {
		return nil, err
	}
	return s.Store.Roles(ctx, id)
}

type RoleWriter interface {
	Assign(context.Context, string, string, string, string, time.Time, func([]string) bool) error
}

func (s SubjectService) Assign(ctx context.Context, caller, target, role string) error {
	if !validID(caller) || !validID(target) || !s.Policy.HasRole(role) || s.Clock == nil {
		return ErrInvalid
	}
	_, d, err := s.authorize(ctx, "security.roles.assign", target)
	if err != nil {
		return err
	}
	writer, ok := s.Store.(RoleWriter)
	if !ok {
		return ErrForbidden
	}
	resource := "/api/v1/access/users/" + target + "/roles"
	return writer.Assign(ctx, caller, target, role, d.PolicyVersion+"/"+s.Policy.version, s.Clock().UTC(), func(roles []string) bool { return s.Policy.Allows(roles, resource, "POST") })
}
