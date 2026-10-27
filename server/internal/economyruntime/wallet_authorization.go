package economyruntime

import (
	"database/sql"
	"fmt"
	"slices"

	"github.com/voxel-vault/api/ledger/adapters/authorization"
	"github.com/voxel-vault/api/ledger/application"
	"github.com/voxel-vault/api/ledger/domain"
	"github.com/voxel-vault/api/security/adapters/policyconfig"
	securitypg "github.com/voxel-vault/api/security/adapters/postgres"
	security "github.com/voxel-vault/api/security/application"
	v1 "github.com/voxel-vault/api/security/contracts/v1"
)

// WalletAuthorizer composes role decisions with Wallet's narrower economic
// capability matrix. Neither context imports the other's private application model.
func WalletAuthorizer(db *sql.DB, grants []authorization.Grant, issuance ...v1.Client) (application.Authorizer, error) {
	policy, err := authorization.New(grants)
	if err != nil {
		return nil, err
	}
	var rules []security.Rule
	for _, role := range []string{"player", "admin"} {
		rules = append(rules, security.Rule{Context: "wallet", Role: role, ActorKind: "user", Permission: "wallet.read", ResourceKind: "owner", Scope: security.Self})
	}
	// Concrete roles are composition data; provisioning and evaluation use the
	// shared Security infrastructure in exactly the same way as Inventory.
	producers := map[string]struct {
		kind, role string
		actions    []domain.Action
	}{
		"player-api":       {kind: "user", actions: []domain.Action{application.ReadCapability}},
		"inventory":        {kind: "service", role: "inventory-settlement", actions: []domain.Action{domain.Reserve, domain.Capture, domain.Cancel, domain.Credit, domain.Close, domain.Payout, domain.ClosePayout, application.ReadCapability}},
		"legacy-opening":   {kind: "operator", role: "wallet-migration", actions: []domain.Action{domain.Credit}},
		"treasury-opening": {kind: "operator", role: "wallet-funding", actions: []domain.Action{domain.FundTreasury}},
	}
	var bindings []authorization.Binding
	var assignments []policyconfig.Binding
	userProducer := ""
	for _, grant := range grants {
		provisioned, ok := producers[grant.Producer]
		if !ok {
			return nil, fmt.Errorf("unprovisioned Wallet producer")
		}
		for _, action := range grant.Actions {
			if !slices.Contains(provisioned.actions, action) {
				return nil, fmt.Errorf("Wallet producer permission exceeds provisioned role")
			}
		}
		if provisioned.kind == "user" {
			userProducer = grant.Producer
			continue
		}
		bindings = append(bindings, authorization.Binding{Producer: grant.Producer, Kind: provisioned.kind, ID: grant.Producer})
		assignments = append(assignments, policyconfig.Binding{Kind: provisioned.kind, ID: grant.Producer, Roles: []string{provisioned.role}})
		for _, action := range grant.Actions {
			rules = append(rules, security.Rule{Context: "wallet", Role: provisioned.role, ActorKind: provisioned.kind, Permission: "wallet." + string(action), ResourceKind: "producer", Scope: security.IdentityScope, Sources: []string{grant.Producer}})
		}
	}
	client, err := policyconfig.New(policyconfig.Policy{Version: "wallet-rbac-v1", Rules: rules, Bindings: assignments}, securitypg.Roles{DB: db})
	if err != nil {
		return nil, err
	}
	return authorization.WithSecurity(policy, client, userProducer, bindings, issuance...)
}
