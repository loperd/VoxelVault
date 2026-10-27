package economyruntime

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"

	"github.com/voxel-vault/api/inventory/adapters/authorization"
	"github.com/voxel-vault/api/inventory/application"
	"github.com/voxel-vault/api/security/adapters/policyconfig"
	securitypg "github.com/voxel-vault/api/security/adapters/postgres"
	security "github.com/voxel-vault/api/security/application"
)

const WorkerPrincipal = "inventory-worker"
const WalletEventsPrincipal = "wallet-events"
const MigrationPrincipal = "economy-cutover"

func InventoryAuthorizer(db *sql.DB, sources []string) (application.Authorizer, error) {
	var rules []security.Rule
	for _, role := range []string{"player", "admin"} {
		for permission, kind := range map[application.Permission]string{application.ReadItems: "owner", application.ReadChests: "owner", application.GrantStarter: "owner", application.ClaimChest: "chest", application.OpenChest: "chest", application.MergeChests: "chest", application.ReadMergeOdds: "chest", application.MergeItems: "item", application.RepairItem: "item", application.SellItem: "item", application.SalvageItem: "item", application.ReadOperation: "operation", application.CancelOperation: "operation"} {
			rules = append(rules, security.Rule{Role: role, ActorKind: "user", Permission: string(permission), ResourceKind: kind, Scope: security.Self})
		}
	}
	rules = append(rules, security.Rule{Role: "admin", ActorKind: "user", Permission: string(application.IssueChests), ResourceKind: "owner", Scope: security.OwnerScope, Sources: []string{"admin"}})
	for _, role := range []string{"inventory-worker", "wallet-settlement"} {
		rules = append(rules, security.Rule{Role: role, ActorKind: "service", Permission: string(application.ObserveSettlement), ResourceKind: "operation", Scope: security.OperationScope})
	}
	rules = append(rules, security.Rule{Role: "inventory-worker", ActorKind: "service", Permission: string(application.ReconcileOperation), ResourceKind: "operation", Scope: security.OperationScope}, security.Rule{Role: "inventory-worker", ActorKind: "service", Permission: string(application.ExecuteDelivery), ResourceKind: "delivery_queue", Scope: security.QueueScope, ResourceIDs: []string{"inventory-settlement"}})
	for _, permission := range []application.Permission{application.ImportItems, application.ImportChests} {
		rules = append(rules, security.Rule{Role: "inventory-migration", ActorKind: "operator", Permission: string(permission), ResourceKind: "baseline", Scope: security.SourceScope, Sources: append([]string(nil), sources...)})
	}
	for i := range rules {
		rules[i].Context = "inventory"
	}
	client, err := policyconfig.New(policyconfig.Policy{Version: "inventory-rbac-v1", Rules: rules, Bindings: []policyconfig.Binding{
		{Kind: "service", ID: WorkerPrincipal, Roles: []string{"inventory-worker"}},
		{Kind: "service", ID: WalletEventsPrincipal, Roles: []string{"wallet-settlement"}},
		{Kind: "operator", ID: MigrationPrincipal, Roles: []string{"inventory-migration"}},
	}}, securitypg.Roles{DB: db})
	if err != nil {
		return nil, err
	}
	return authorization.Security{Client: client}, nil
}

func ServiceContext(ctx context.Context, id string) context.Context {
	return application.WithAuthenticatedPrincipal(ctx, application.Principal{Kind: "service", ID: id})
}
func OperatorContext(ctx context.Context) context.Context {
	return application.WithAuthenticatedPrincipal(ctx, application.Principal{Kind: "operator", ID: MigrationPrincipal})
}

func StarterPolicy(text string) (func([]application.Grant) bool, error) {
	expected := map[string]int{}
	total := 0
	for _, part := range strings.Split(text, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		kind, countText, ok := strings.Cut(part, ":")
		count, err := strconv.Atoi(strings.TrimSpace(countText))
		kind = strings.TrimSpace(kind)
		if !ok || err != nil || count < 1 || count > application.MaxIssue {
			return nil, fmt.Errorf("invalid starter plan")
		}
		expected[kind] += count
		total += count
		if total > application.MaxIssue {
			return nil, fmt.Errorf("starter plan exceeds issuance limit")
		}
	}
	return func(grants []application.Grant) bool {
		actual := map[string]int{}
		for _, grant := range grants {
			actual[grant.Type] += grant.Count
		}
		if len(actual) != len(expected) {
			return false
		}
		for kind, count := range actual {
			if expected[kind] != count {
				return false
			}
		}
		return true
	}, nil
}
