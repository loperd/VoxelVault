package v1

import "context"

// Subject registration never accepts a role from an external request.
type SubjectRegistration struct{ CommandID, Subject string }
type SubjectReceipt struct{ CommandID, Subject, Role, PolicyVersion string }
type Permission struct{ Resource, Action string }
type PermissionCheck struct{ Subject, Resource, Action string }
type Subjects interface {
	Roles(context.Context, string) ([]string, error)
	Assign(context.Context, string, string, string) error
	Register(context.Context, SubjectRegistration) (SubjectReceipt, error)
	Permissions(context.Context, string) ([]Permission, error)
	Catalog(context.Context) ([]Permission, error)
	Check(context.Context, PermissionCheck) (bool, error)
}
type SubjectError struct{ Code string }

func (e *SubjectError) Error() string { return "security subject: " + e.Code }
