package application_test

import (
	s "github.com/voxel-vault/api/security/application"
	"testing"
)

func TestRolePolicyInheritanceScopesAndImmutability(t *testing.T) {
	spec := s.RolePolicySpec{Version: "roles-v1", Roles: []s.RoleDefinition{{ID: "reader", Permissions: []s.Permission{{Resource: "/accounts/*", Action: "read"}}}, {ID: "manager", Parents: []string{"reader"}, Permissions: []s.Permission{{Resource: "/accounts/*", Action: "write"}}}}}
	policy, err := s.NewRolePolicy(spec)
	if err != nil {
		t.Fatal(err)
	}
	if !policy.Allows([]string{"manager"}, "/accounts/alice", "read") || !policy.Allows([]string{"manager"}, "/accounts/alice", "write") {
		t.Fatal("inherited permissions missing")
	}
	if policy.Allows([]string{"reader"}, "/accounts/alice", "write") || policy.Allows([]string{"unknown"}, "/accounts/alice", "read") || policy.Allows([]string{"reader"}, "/accounts/alice/private", "read") {
		t.Fatal("permission scope widened")
	}
	spec.Roles[0].Permissions[0].Resource = "*"
	catalog := policy.Catalog()
	catalog[0].Resource = "*"
	if policy.Allows([]string{"reader"}, "/other", "read") {
		t.Fatal("active policy mutated through configuration")
	}
}
func TestInvalidRoleDefinitionsFailClosed(t *testing.T) {
	for _, roles := range [][]s.RoleDefinition{{{ID: "a", Parents: []string{"missing"}}}, {{ID: "a", Parents: []string{"b"}}, {ID: "b", Parents: []string{"a"}}}, {{ID: "a"}, {ID: "a"}}, {{ID: "a", Permissions: []s.Permission{{Resource: "[", Action: "read"}}}}} {
		if _, err := s.NewRolePolicy(s.RolePolicySpec{Version: "v1", Roles: roles}); err == nil {
			t.Fatal("invalid role policy accepted", roles)
		}
	}
}
