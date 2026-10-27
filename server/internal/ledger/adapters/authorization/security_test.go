package authorization_test

import (
	"context"
	"errors"
	"testing"

	a "github.com/voxel-vault/api/internal/ledger/adapters/authorization"
	"github.com/voxel-vault/api/internal/ledger/application"
	"github.com/voxel-vault/api/internal/ledger/domain"
	v1 "github.com/voxel-vault/api/internal/security/contracts/v1"
)

type clientFunc func(context.Context, v1.Request) (v1.Decision, error)

func (f clientFunc) Decide(c context.Context, r v1.Request) (v1.Decision, error) { return f(c, r) }

func TestSecurityFailureAndEconomicScopesFailClosed(t *testing.T) {
	policy, err := a.New([]a.Grant{{Producer: "inventory", Actions: []domain.Action{domain.Credit, domain.Payout}, Assets: []string{"ore", "coins"}, AllSubjects: true, Purposes: []domain.Purpose{domain.Reward, domain.Buyback}, Treasuries: []string{"buyback"}, Scopes: []a.ResourceScope{{Purpose: domain.Reward, Assets: []string{"ore"}}, {Purpose: domain.Buyback, Assets: []string{"coins"}}}}})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	terms := &domain.Terms{Subject: "alice", Asset: "ore", Units: 1, Purpose: domain.Reward}
	for _, test := range []struct {
		name     string
		decision v1.Decision
		err      error
		allow    bool
	}{
		{"allow", v1.Decision{Allowed: true, PolicyVersion: "wallet-1"}, nil, true},
		{"deny", v1.Decision{PolicyVersion: "wallet-1"}, nil, false},
		{"unversioned", v1.Decision{Allowed: true}, nil, false},
		{"offline", v1.Decision{}, errors.New("Security offline"), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, err := a.WithSecurity(policy, clientFunc(func(_ context.Context, r v1.Request) (v1.Decision, error) {
				if r.Context != "wallet" || r.Permission != "wallet.credit" || r.ActorKind != "service" || r.ActorID != "inventory" || r.ResourceID != "inventory" || r.Source != "inventory" {
					t.Fatal(r)
				}
				return test.decision, test.err
			}), "", []a.Binding{{Producer: "inventory", Kind: "service", ID: "inventory"}})
			if err != nil {
				t.Fatal(err)
			}
			if err = s.Authorize(ctx, "inventory", domain.Credit, terms); (err == nil) != test.allow {
				t.Fatal(err)
			}
		})
	}
	calls := 0
	s, err := a.WithSecurity(policy, clientFunc(func(context.Context, v1.Request) (v1.Decision, error) {
		calls++
		return v1.Decision{Allowed: true, PolicyVersion: "wallet-1"}, nil
	}), "", []a.Binding{{Producer: "inventory", Kind: "service", ID: "inventory"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []domain.Terms{
		{Subject: "alice", Asset: "coins", Units: 1, Purpose: domain.Reward},
		{Subject: "alice", Asset: "coins", Units: 1, Purpose: domain.Buyback, Treasury: "foreign"},
	} {
		if err = s.Authorize(ctx, "inventory", domain.Credit, &bad); !errors.Is(err, application.ErrForbidden) {
			t.Fatal(err)
		}
	}
	if calls != 0 {
		t.Fatal("economic denial reached Security", calls)
	}
	unbound, err := a.WithSecurity(policy, clientFunc(func(context.Context, v1.Request) (v1.Decision, error) {
		t.Fatal("unbound producer reached Security")
		return v1.Decision{}, nil
	}), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = unbound.Authorize(ctx, "inventory", domain.Credit, terms); !errors.Is(err, application.ErrForbidden) {
		t.Fatal(err)
	}
}

func TestIssuanceRequiresProvisionedOperatorAndVersionedSecurityDecision(t *testing.T) {
	policy, err := a.New([]a.Grant{{Producer: "operator", Actions: []domain.Action{domain.FundTreasury}, Assets: []string{"coins"}, Subjects: []string{"system"}, Purposes: []domain.Purpose{domain.TreasuryOpening}, Treasuries: []string{"buyback"}, MaxUnits: 10}})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name     string
		decision v1.Decision
		failure  error
	}{
		{"denied", v1.Decision{PolicyVersion: "policy-1"}, nil},
		{"unversioned", v1.Decision{Allowed: true}, nil},
		{"offline", v1.Decision{}, errors.New("Security offline")},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := clientFunc(func(context.Context, v1.Request) (v1.Decision, error) { return test.decision, test.failure })
			secured, err := a.WithSecurity(policy, client, "", []a.Binding{{Producer: "operator", Kind: "operator", ID: "operator"}}, client)
			if err != nil {
				t.Fatal(err)
			}
			request := application.Issuance{Purpose: domain.TreasuryOpening, Source: "approved", Reference: "approval-1", Treasury: "buyback", Totals: map[string]int64{"coins": 10}}
			if err = secured.AuthorizeIssuance(context.Background(), "operator", request); err == nil {
				t.Fatal("unapproved issuance allowed")
			}
			if test.failure != nil && !errors.Is(err, test.failure) {
				t.Fatal(err)
			}
		})
	}
}
