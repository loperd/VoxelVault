package security

import (
	"context"
	"errors"

	"github.com/voxel-vault/api/identity/application"
	"github.com/voxel-vault/api/identity/domain"
	v1 "github.com/voxel-vault/api/security/contracts/v1"
)

type Subjects struct{ Client v1.Subjects }

func (s Subjects) Allowed(ctx context.Context, subject, resource, action string) (bool, error) {
	if s.Client == nil {
		return false, domain.ErrForbidden
	}
	v, err := s.Client.Check(ctx, v1.PermissionCheck{Subject: subject, Resource: resource, Action: action})
	return v, publicError(err)
}

func (s Subjects) Register(ctx context.Context, id, subject string) (application.RoleReceipt, error) {
	if s.Client == nil {
		return application.RoleReceipt{}, domain.ErrForbidden
	}
	r, err := s.Client.Register(ctx, v1.SubjectRegistration{CommandID: id, Subject: subject})
	return application.RoleReceipt{CommandID: r.CommandID, Subject: r.Subject, Role: r.Role, PolicyVersion: r.PolicyVersion}, publicError(err)
}
func (s Subjects) Permissions(ctx context.Context, id string) ([]string, error) {
	if s.Client == nil {
		return nil, domain.ErrForbidden
	}
	v, err := s.Client.Permissions(ctx, id)
	return scopes(v), publicError(err)
}
func (s Subjects) Catalog(ctx context.Context) ([]string, error) {
	if s.Client == nil {
		return nil, domain.ErrForbidden
	}
	v, err := s.Client.Catalog(ctx)
	return scopes(v), publicError(err)
}
func scopes(v []v1.Permission) []string {
	out := make([]string, 0, len(v))
	for _, p := range v {
		out = append(out, p.Action+":"+p.Resource)
	}
	return out
}
func publicError(err error) error {
	var e *v1.SubjectError
	if errors.As(err, &e) {
		switch e.Code {
		case "forbidden":
			return domain.ErrForbidden
		case "invalid":
			return domain.ErrInvalid
		case "conflict":
			return application.ErrConflict
		}
	}
	return err
}
