package postgres_test

import (
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/voxel-vault/api/internal/economyruntime"
	"github.com/voxel-vault/api/internal/ledger/adapters/authorization"
	"github.com/voxel-vault/api/internal/ledger/application"
	"github.com/voxel-vault/api/internal/ledger/domain"
	"github.com/voxel-vault/api/internal/security/adapters/policyconfig"
	s "github.com/voxel-vault/api/internal/security/application"
	v1 "github.com/voxel-vault/api/internal/security/contracts/v1"
)

func issuancePolicy(t *testing.T, producer, purpose, source, reference, treasury, limit string) v1.Client {
	t.Helper()
	p := policyconfig.Policy{Version: "approved-1", Bindings: []policyconfig.Binding{{Kind: "operator", ID: producer, Roles: []string{"allocator"}}}}
	for _, permission := range []string{"wallet.issue." + purpose, "wallet.issue." + purpose + ".asset"} {
		p.Rules = append(p.Rules, s.Rule{Context: "wallet", Role: "allocator", ActorKind: "operator", Permission: permission, ResourceKind: "issuance", Scope: s.ResourceScope, ResourceIDs: []string{source}, Attributes: map[string]s.Constraint{"reference": {Values: []string{reference}}, "treasury": {Values: []string{treasury}}}})
	}
	p.Rules[1].Attributes["asset"] = s.Constraint{Values: []string{"coins"}}
	p.Rules[1].Attributes["units"] = s.Constraint{Maximum: limit}
	client, err := policyconfig.New(p, nil)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestOpeningApprovalsPinSourceDigestAndAggregateAssetAllocation(t *testing.T) {
	db, store := operatorDatabase(t)
	digest := strings.Repeat("a", 64)
	gate := issuancePolicy(t, "legacy-opening", "opening_balance", "approved-source", digest, "", "10")
	auth, err := economyruntime.WalletAuthorizer(nil, []authorization.Grant{{Producer: "legacy-opening", Actions: []domain.Action{domain.Credit}, Assets: []string{"coins"}, AllSubjects: true, Purposes: []domain.Purpose{domain.OpeningBalance}}}, gate)
	if err != nil {
		t.Fatal(err)
	}
	svc := application.OpeningService{Store: store, Authorizer: auth, Producer: "legacy-opening"}
	input := application.Opening{Source: "approved-source", Digest: digest, At: time.Now().UTC(), Balances: []application.OpeningBalance{{Subject: "alice", Asset: "coins", Units: 5}, {Subject: "bob", Asset: "coins", Units: 5}}}
	for _, test := range []struct {
		name    string
		change  func(*application.Opening)
		invalid bool
	}{
		{"source", func(i *application.Opening) { i.Source = "unapproved" }, false},
		{"digest", func(i *application.Opening) { i.Digest = strings.Repeat("b", 64) }, false},
		{"split-over-cap", func(i *application.Opening) { i.Balances[1].Units = 6 }, false},
		{"zero-foreign-asset", func(i *application.Opening) { i.Balances[1].Asset = "foreign"; i.Balances[1].Units = 0 }, false},
		{"overflow", func(i *application.Opening) { i.Balances[0].Units = math.MaxInt64; i.Balances[1].Units = 1 }, true},
		{"empty-foreign-baseline", func(i *application.Opening) { i.Source = "unapproved"; i.Balances = nil }, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			bad := input
			bad.Balances = append([]application.OpeningBalance(nil), input.Balances...)
			test.change(&bad)
			err := svc.Import(ctx, bad)
			expected := application.ErrForbidden
			if test.invalid {
				expected = domain.ErrInvalid
			}
			if !errors.Is(err, expected) {
				t.Fatal(err)
			}
			for _, table := range []string{"commands", "intents", "journals", "accounts", "postings", "outbox", "opening_baseline"} {
				if count(t, db, table) != 0 {
					t.Fatal("denied opening wrote state", table)
				}
			}
		})
	}
	if err = svc.Import(ctx, input); err != nil {
		t.Fatal(err)
	}
	if err = svc.Import(ctx, input); err != nil {
		t.Fatal("approved replay", err)
	}
	if count(t, db, "journals") != 2 || count(t, db, "opening_baseline") != 1 {
		t.Fatal("opening replay issued twice")
	}
}

func TestTreasuryApprovalsRequireNamedSourceReferenceAndCap(t *testing.T) {
	db, store := operatorDatabase(t)
	grant := authorization.Grant{Producer: "treasury-opening", Actions: []domain.Action{domain.FundTreasury}, Assets: []string{"coins"}, Subjects: []string{"system"}, Purposes: []domain.Purpose{domain.TreasuryOpening}, Treasuries: []string{"buyback", "other"}, MaxUnits: 100}
	gate := issuancePolicy(t, "treasury-opening", "treasury_opening", "approved-source", "allocation-7", "buyback", "10")
	auth, err := economyruntime.WalletAuthorizer(nil, []authorization.Grant{grant}, gate)
	if err != nil {
		t.Fatal(err)
	}
	svc := application.TreasuryOpeningService{Store: store, Authorizer: auth, Producer: "treasury-opening", Clock: time.Now}
	input := application.TreasuryOpening{Treasury: "buyback", Asset: "coins", Units: 10, Source: "approved-source", Reference: "allocation-7"}
	for _, change := range []func(*application.TreasuryOpening){
		func(i *application.TreasuryOpening) { i.Source = "foreign" }, func(i *application.TreasuryOpening) { i.Reference = "allocation-8" }, func(i *application.TreasuryOpening) { i.Treasury = "other" }, func(i *application.TreasuryOpening) { i.Units = 11 },
	} {
		bad := input
		change(&bad)
		if _, err = svc.Open(ctx, bad); !errors.Is(err, application.ErrForbidden) {
			t.Fatal(err)
		}
	}
	for _, table := range []string{"accounts", "intents", "journals", "postings", "outbox", "treasury_openings"} {
		if count(t, db, table) != 0 {
			t.Fatal("denied funding wrote state", table)
		}
	}
	// Having the economic capability alone never approves issuance.
	bare, err := authorization.New([]authorization.Grant{grant})
	if err != nil {
		t.Fatal(err)
	}
	unapproved := svc
	unapproved.Authorizer = bare
	if _, err = unapproved.Open(ctx, input); !errors.Is(err, application.ErrForbidden) {
		t.Fatal("missing issuance port allowed funding", err)
	}
	first, err := svc.Open(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.Open(ctx, input)
	if err != nil || first.JournalID != second.JournalID {
		t.Fatal(second, err)
	}
	if count(t, db, "journals") != 1 {
		t.Fatal("approved replay minted twice")
	}
}
