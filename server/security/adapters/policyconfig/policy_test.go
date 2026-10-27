package policyconfig_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/voxel-vault/api/security/adapters/policyconfig"
	s "github.com/voxel-vault/api/security/application"
	v1 "github.com/voxel-vault/api/security/contracts/v1"
)

func TestOnePolicyEngineEnforcesUnrelatedContextsAndExactResourceLimits(t *testing.T) {
	p := policyconfig.Policy{Version: "shared-1", Bindings: []policyconfig.Binding{{Kind: "operator", ID: "ops", Roles: []string{"allocator", "stock-operator"}}}, Rules: []s.Rule{
		{Context: "wallet", Role: "allocator", ActorKind: "operator", Permission: "allocate", ResourceKind: "budget", Scope: s.ResourceScope, ResourceIDs: []string{"approved-source"}, Attributes: map[string]s.Constraint{"reference": {Values: []string{"approval-7"}}, "asset": {Values: []string{"coins"}}, "units": {Maximum: "9007199254740993"}}},
		{Context: "inventory", Role: "stock-operator", ActorKind: "operator", Permission: "transfer", ResourceKind: "warehouse", Scope: s.ResourceScope, ResourceIDs: []string{"main"}, Attributes: map[string]s.Constraint{"destination": {Values: []string{"repair"}}, "count": {Maximum: "3"}}},
	}}
	client, err := policyconfig.New(p, nil)
	if err != nil {
		t.Fatal(err)
	}
	base := v1.Request{ActorKind: "operator", ActorID: "ops", Context: "wallet", Permission: "allocate", ResourceKind: "budget", ResourceID: "approved-source", Attributes: map[string]string{"reference": "approval-7", "asset": "coins", "units": "9007199254740993"}}
	for _, test := range []struct {
		name, key, value string
		allow            bool
	}{
		{"exact-large-limit", "units", "9007199254740993", true},
		{"above-limit", "units", "9007199254740994", false},
		{"foreign-approval", "reference", "approval-8", false},
		{"foreign-asset", "asset", "ore", false},
		{"negative", "units", "-1", false},
		{"exponent", "units", "9e3", false},
		{"noncanonical", "units", "01", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := base
			r.Attributes = map[string]string{}
			for k, v := range base.Attributes {
				r.Attributes[k] = v
			}
			r.Attributes[test.key] = test.value
			d, err := client.Decide(context.Background(), r)
			if err != nil || d.Allowed != test.allow || d.PolicyVersion != "shared-1" {
				t.Fatal(d, err)
			}
		})
	}
	for _, mutate := range []func(*v1.Request){
		func(r *v1.Request) { r.ActorKind = "user" },
		func(r *v1.Request) { r.ActorID = "unknown" },
		func(r *v1.Request) { r.Context = "shop" },
		func(r *v1.Request) { r.ResourceID = "foreign-source" },
		func(r *v1.Request) { r.Attributes = nil },
	} {
		r := base
		mutate(&r)
		d, err := client.Decide(context.Background(), r)
		if err != nil || d.Allowed {
			t.Fatal(d, err)
		}
	}
	stock := v1.Request{ActorKind: "operator", ActorID: "ops", Context: "inventory", Permission: "transfer", ResourceKind: "warehouse", ResourceID: "main", Attributes: map[string]string{"destination": "repair", "count": "3"}}
	if d, err := client.Decide(context.Background(), stock); err != nil || !d.Allowed {
		t.Fatal(d, err)
	}
	stock.Attributes["destination"] = "unknown"
	if d, err := client.Decide(context.Background(), stock); err != nil || d.Allowed {
		t.Fatal(d, err)
	}
	// Construction takes ownership of policy data; later config edits cannot
	// silently widen an already active policy version.
	p.Bindings[0].Roles[0] = "unknown"
	p.Rules[0].Attributes["units"] = s.Constraint{Maximum: "0"}
	p.Rules[0].Attributes["asset"].Values[0] = "ore"
	if d, err := client.Decide(context.Background(), base); err != nil || !d.Allowed {
		t.Fatal(d, err)
	}
}

func TestPolicyFileRejectsMalformedAndAmbiguousProvisioning(t *testing.T) {
	valid := policyconfig.Policy{Version: "file-1", Bindings: []policyconfig.Binding{{Kind: "operator", ID: "ops", Roles: []string{"allocator"}}}, Rules: []s.Rule{{Context: "any-context", Role: "allocator", ActorKind: "operator", Permission: "allocate", ResourceKind: "resource", Scope: s.ResourceScope, ResourceIDs: []string{"approved"}, Attributes: map[string]s.Constraint{"units": {Maximum: "3"}}}}}
	raw, err := json.Marshal(valid)
	if err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"valid": string(raw), "unknown-field": strings.Replace(string(raw), `"version":`, `"typo":`, 1), "trailing": string(raw) + ` {}`, "oversized": strings.Repeat(" ", 1<<20+1), "empty": "{}",
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "policy.json")
			if err := os.WriteFile(path, []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
			_, err := policyconfig.Load(path)
			if (err == nil) != (name == "valid") {
				t.Fatal(err)
			}
		})
	}
	valid.Bindings = append(valid.Bindings, valid.Bindings[0])
	if _, err := policyconfig.New(valid, nil); err == nil {
		t.Fatal("duplicate actor binding accepted")
	}
	valid.Bindings = valid.Bindings[:1]
	valid.Rules[0].Attributes["units"] = s.Constraint{Maximum: "1e9"}
	if _, err := policyconfig.New(valid, nil); err == nil {
		t.Fatal("inexact maximum accepted")
	}
}
