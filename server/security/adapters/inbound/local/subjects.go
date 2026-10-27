package local

import (
	"context"
	"errors"

	"github.com/voxel-vault/api/security/application"
	v1 "github.com/voxel-vault/api/security/contracts/v1"
)

type Subjects struct {
	Service application.SubjectService
	Actor   application.Actor
}

func (c Subjects) Check(ctx context.Context, r v1.PermissionCheck) (bool, error) {
	v, err := c.Service.Check(application.WithAuthenticatedActor(ctx, c.Actor), r.Subject, r.Resource, r.Action)
	return v, subjectError(err)
}

func (c Subjects) Register(ctx context.Context, r v1.SubjectRegistration) (v1.SubjectReceipt, error) {
	v, err := c.Service.Register(application.WithAuthenticatedActor(ctx, c.Actor), application.SubjectRegistration{CommandID: r.CommandID, Subject: r.Subject})
	return v1.SubjectReceipt{CommandID: v.CommandID, Subject: v.Subject, Role: v.Role, PolicyVersion: v.PolicyVersion}, subjectError(err)
}
func (c Subjects) Permissions(ctx context.Context, id string) ([]v1.Permission, error) {
	v, err := c.Service.Permissions(application.WithAuthenticatedActor(ctx, c.Actor), id)
	return permissions(v), subjectError(err)
}
func (c Subjects) Catalog(ctx context.Context) ([]v1.Permission, error) {
	v, err := c.Service.Catalog(application.WithAuthenticatedActor(ctx, c.Actor))
	return permissions(v), subjectError(err)
}
func permissions(input []application.Permission) []v1.Permission {
	out := make([]v1.Permission, 0, len(input))
	for _, p := range input {
		out = append(out, v1.Permission{Resource: p.Resource, Action: p.Action})
	}
	return out
}
func subjectError(err error) error {
	if err == nil {
		return nil
	}
	code := "unavailable"
	switch {
	case errors.Is(err, application.ErrInvalid):
		code = "invalid"
	case errors.Is(err, application.ErrForbidden):
		code = "forbidden"
	case errors.Is(err, application.ErrConflict):
		code = "conflict"
	}
	return &v1.SubjectError{Code: code}
}

func (c Subjects) Roles(ctx context.Context, id string) ([]string, error) {
	v, e := c.Service.Roles(application.WithAuthenticatedActor(ctx, c.Actor), id)
	return v, subjectError(e)
}
func (c Subjects) Assign(ctx context.Context, caller, target, role string) error {
	return subjectError(c.Service.Assign(application.WithAuthenticatedActor(ctx, c.Actor), caller, target, role))
}
