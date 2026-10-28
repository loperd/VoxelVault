package identityruntime

import (
	"context"
	"fmt"
	"github.com/voxel-vault/api/platform/resourcegrants"
	"log"
	"time"

	"github.com/voxel-vault/api/identity/adapters/authorization"
	"github.com/voxel-vault/api/identity/adapters/inbound/local"
	"github.com/voxel-vault/api/identity/adapters/postgres"
	roles "github.com/voxel-vault/api/identity/adapters/security"
	"github.com/voxel-vault/api/identity/application"
	"github.com/voxel-vault/api/internal/securityruntime"
	"github.com/voxel-vault/api/security/adapters/policyconfig"
	security "github.com/voxel-vault/api/security/application"
)

const RegistrationWorker = "identity-registration-worker"

func AccountsAuthorizer(gateway string) (application.Authorizer, error) {
	var rules []security.Rule
	for permission, kind := range map[string]string{"identity.profile.read": "account", "identity.provider.resolve": "provider", "identity.provider.link": "account", "identity.permissions.read": "account", "identity.permissions.catalog": "catalog"} {
		rules = append(rules, security.Rule{Context: "identity", Role: "identity-gateway", ActorKind: "service", Permission: permission, ResourceKind: kind, Scope: security.OwnerScope, Sources: []string{gateway}})
	}
	rules = append(rules, security.Rule{Context: "identity", Role: "registration-worker", ActorKind: "service", Permission: "identity.registration.resume", ResourceKind: "registrations", Scope: security.QueueScope, ResourceIDs: []string{"pending"}})
	client, err := policyconfig.New(policyconfig.Policy{Version: "identity-accounts-rbac-v1", Bindings: []policyconfig.Binding{{Kind: "service", ID: gateway, Roles: []string{"identity-gateway"}}, {Kind: "service", ID: RegistrationWorker, Roles: []string{"registration-worker"}}}, Rules: rules}, nil)
	if err != nil {
		return nil, err
	}
	return authorization.Security{Client: client}, nil
}

// EnableAccounts is a composition step: call it before starting handlers/workers.
func (r *Runtime) EnableAccounts(ctx context.Context, securityDSN, defaultRole string, providers []string) error {
	if securityDSN == "" || len(providers) == 0 {
		return fmt.Errorf("Security connection and providers are required")
	}
	sec, err := securityruntime.Open(ctx, securityDSN, "identity-registrar", defaultRole)
	if err != nil {
		return err
	}
	auth, err := AccountsAuthorizer(r.gateway)
	if err != nil {
		sec.Close()
		return err
	}
	registry := postgres.Registry{DB: r.DB}
	service := application.Accounts{Grants: resourcegrants.Allows, Registry: registry, Profiles: registry, Recipient: registry, Sessions: r.sessionService, Roles: roles.Subjects{Client: sec.Subjects}, Authorizer: auth, Clock: time.Now, ID: r.sessionService.ID, Providers: append([]string(nil), providers...)}
	client := local.Accounts{Service: service, Principal: application.Principal{Kind: "service", ID: r.gateway}}
	r.Accounts = client
	r.Profiles = client
	r.Recipient = client
	r.Security = sec.Subjects
	r.SecurityDB = sec.DB
	r.registration = &service
	r.closers = append(r.closers, func() error { sec.Close(); return nil })
	r.checks = append(r.checks, sec.Ready)
	return nil
}

func (r *Runtime) Run(ctx context.Context) {
	if r.registration == nil {
		return
	}
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		pass, cancel := context.WithTimeout(ctx, 10*time.Second)
		_, err := r.registration.ResumePending(application.WithAuthenticatedPrincipal(pass, application.Principal{Kind: "service", ID: RegistrationWorker}), 64)
		cancel()
		if err != nil && ctx.Err() == nil {
			log.Printf("Identity registration recovery: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
