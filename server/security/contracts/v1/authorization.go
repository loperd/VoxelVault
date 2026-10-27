package v1

import "context"

type Request struct {
	ActorKind, ActorID, Permission, Context, ResourceKind, ResourceID, Owner, Source, Version, OperationScope string
	Attributes                                                                                                map[string]string
}
type Decision struct {
	Allowed       bool
	PolicyVersion string
}
type Client interface {
	Decide(context.Context, Request) (Decision, error)
}
