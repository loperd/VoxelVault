package application_test

import (
	"context"
	"errors"
	"testing"
	"time"

	s "github.com/voxel-vault/api/security/application"
)

type unusedStore struct{ t *testing.T }

func (p unusedStore) Register(context.Context, s.SubjectReceipt) (s.SubjectReceipt, error) {
	p.t.Fatal("denied subject registration reached persistence")
	return s.SubjectReceipt{}, nil
}
func (p unusedStore) Roles(context.Context, string) ([]string, error) {
	p.t.Fatal("denied permissions reached persistence")
	return nil, nil
}
func (p unusedStore) Catalog(context.Context) ([]s.Permission, error) {
	p.t.Fatal("denied catalog reached persistence")
	return nil, nil
}

type decisionsFunc func(context.Context, s.Request) (s.Decision, error)

func (f decisionsFunc) Decide(ctx context.Context, r s.Request) (s.Decision, error) { return f(ctx, r) }
func TestSubjectServicesRequireVersionedAuthorizationBeforeIO(t *testing.T) {
	policy, err := s.NewRolePolicy(s.RolePolicySpec{Version: "test", Roles: []s.RoleDefinition{{ID: "player"}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		decision s.Decision
		err      error
	}{{s.Decision{}, nil}, {s.Decision{Allowed: true}, nil}, {s.Decision{}, errors.New("policy unavailable")}} {
		service := s.SubjectService{Store: unusedStore{t}, DefaultRole: "player", Clock: time.Now, Policy: policy, Authorizer: decisionsFunc(func(context.Context, s.Request) (s.Decision, error) { return test.decision, test.err })}
		ctx := s.WithAuthenticatedActor(context.Background(), s.Actor{Kind: "service", ID: "identity"})
		want := test.err
		if want == nil {
			want = s.ErrForbidden
		}
		if _, err := service.Register(ctx, s.SubjectRegistration{CommandID: "command", Subject: "alice"}); !errors.Is(err, want) {
			t.Fatal("registration allowed")
		}
		if _, err := service.Permissions(ctx, "alice"); !errors.Is(err, want) {
			t.Fatal("permission read allowed")
		}
		if _, err := service.Catalog(ctx); !errors.Is(err, want) {
			t.Fatal("catalog allowed")
		}
		if _, err := service.Check(ctx, "alice", "/resource", "read"); !errors.Is(err, want) {
			t.Fatal("check allowed")
		}
	}
}
