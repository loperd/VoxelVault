package application_test

import (
	"context"
	"errors"
	s "github.com/voxel-vault/api/security/application"
	"testing"
)

type rolesFunc func(context.Context, s.Actor) ([]string, error)

func (f rolesFunc) Roles(c context.Context, a s.Actor) ([]string, error) { return f(c, a) }

func TestSecurityScopesDenyUnknownAndCrossResourceRequests(t *testing.T) {
	roles := rolesFunc(func(context.Context, s.Actor) ([]string, error) {
		return []string{"player", "admin", "worker", "operator"}, nil
	})
	engine, err := s.New(roles, []s.Rule{
		{Context: "inventory", Role: "player", ActorKind: "user", Permission: "read", ResourceKind: "owner", Scope: s.Self},
		{Context: "inventory", Role: "admin", ActorKind: "user", Permission: "issue", ResourceKind: "owner", Scope: s.OwnerScope, Sources: []string{"admin"}},
		{Context: "inventory", Role: "worker", ActorKind: "service", Permission: "observe", ResourceKind: "operation", Scope: s.OperationScope},
		{Context: "inventory", Role: "operator", ActorKind: "operator", Permission: "import", ResourceKind: "baseline", Scope: s.SourceScope, Sources: []string{"approved-source"}},
		{Context: "inventory", Role: "worker", ActorKind: "service", Permission: "settle", ResourceKind: "producer", Scope: s.IdentityScope, Sources: []string{"inventory"}},
	}, "policy-1")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name    string
		request s.Request
		allow   bool
	}{
		{"self", s.Request{Actor: s.Actor{Kind: "user", ID: "alice"}, Permission: "read", ResourceKind: "owner", ResourceID: "alice", Owner: "alice"}, true},
		{"foreign-owner", s.Request{Actor: s.Actor{Kind: "user", ID: "alice"}, Permission: "read", ResourceKind: "owner", ResourceID: "bob", Owner: "bob"}, false},
		{"inconsistent-owner-id", s.Request{Actor: s.Actor{Kind: "user", ID: "alice"}, Permission: "read", ResourceKind: "owner", ResourceID: "bob", Owner: "alice"}, false},
		{"explicit-admin-source", s.Request{Actor: s.Actor{Kind: "user", ID: "alice"}, Permission: "issue", ResourceKind: "owner", ResourceID: "bob", Owner: "bob", Source: "admin"}, true},
		{"wrong-admin-source", s.Request{Actor: s.Actor{Kind: "user", ID: "alice"}, Permission: "issue", ResourceKind: "owner", ResourceID: "bob", Owner: "bob", Source: "starter"}, false},
		{"delegated-operation", s.Request{Actor: s.Actor{Kind: "service", ID: "worker"}, Permission: "observe", ResourceKind: "operation", ResourceID: "op", OperationScope: "op"}, true},
		{"wrong-delegation", s.Request{Actor: s.Actor{Kind: "service", ID: "worker"}, Permission: "observe", ResourceKind: "operation", ResourceID: "op", OperationScope: "other"}, false},
		{"user-cannot-use-service-role", s.Request{Actor: s.Actor{Kind: "user", ID: "worker"}, Permission: "observe", ResourceKind: "operation", ResourceID: "op", OperationScope: "op"}, false},
		{"approved-source", s.Request{Actor: s.Actor{Kind: "operator", ID: "operator"}, Permission: "import", ResourceKind: "baseline", ResourceID: "approved-source", Source: "approved-source", Version: "digest"}, true},
		{"wrong-source", s.Request{Actor: s.Actor{Kind: "operator", ID: "operator"}, Permission: "import", ResourceKind: "baseline", ResourceID: "other", Source: "other", Version: "digest"}, false},
		{"unknown-permission", s.Request{Actor: s.Actor{Kind: "user", ID: "alice"}, Permission: "unknown", ResourceKind: "owner", ResourceID: "alice", Owner: "alice"}, false},
		{"bound-producer", s.Request{Actor: s.Actor{Kind: "service", ID: "worker"}, Permission: "settle", ResourceKind: "producer", ResourceID: "worker", Source: "inventory"}, true},
		{"foreign-producer", s.Request{Actor: s.Actor{Kind: "service", ID: "worker"}, Permission: "settle", ResourceKind: "producer", ResourceID: "worker", Source: "shop"}, false},
		{"foreign-identity", s.Request{Actor: s.Actor{Kind: "service", ID: "worker"}, Permission: "settle", ResourceKind: "producer", ResourceID: "other", Source: "inventory"}, false},
		{"user-is-not-bound-producer", s.Request{Actor: s.Actor{Kind: "user", ID: "worker"}, Permission: "settle", ResourceKind: "producer", ResourceID: "worker", Source: "inventory"}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			test.request.Context = "inventory"
			d, err := engine.Decide(context.Background(), test.request)
			if err != nil || d.Allowed != test.allow || d.PolicyVersion != "policy-1" {
				t.Fatal(d, err)
			}
		})
	}
	broken, _ := s.New(rolesFunc(func(context.Context, s.Actor) ([]string, error) { return nil, errors.New("role directory offline") }), nil, "policy-1")
	if d, err := broken.Decide(context.Background(), s.Request{Context: "inventory", Actor: s.Actor{Kind: "user", ID: "alice"}, Permission: "read", ResourceID: "alice"}); err == nil || d.Allowed {
		t.Fatal(d, err)
	}
}
