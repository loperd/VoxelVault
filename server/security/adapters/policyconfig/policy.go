// Package policyconfig provisions the same policy engine for any bounded context.
// Static service/operator bindings and optional user-role storage are independent
// of resource names and business operations.
package policyconfig

import (
	"context"
	"fmt"

	"github.com/voxel-vault/api/platform/configjson"
	"github.com/voxel-vault/api/security/adapters/inbound/local"
	"github.com/voxel-vault/api/security/application"
	v1 "github.com/voxel-vault/api/security/contracts/v1"
)

type Binding struct {
	Kind  string   `json:"kind"`
	ID    string   `json:"id"`
	Roles []string `json:"roles"`
}

type Policy struct {
	Version  string             `json:"version"`
	Bindings []Binding          `json:"bindings"`
	Rules    []application.Rule `json:"rules"`
}

type directory struct {
	bindings map[application.Actor][]string
	users    application.Roles
}

func (d directory) Roles(ctx context.Context, actor application.Actor) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if roles, ok := d.bindings[actor]; ok {
		return append([]string(nil), roles...), nil
	}
	if actor.Kind == "user" && d.users != nil {
		return d.users.Roles(ctx, actor)
	}
	return nil, nil
}

func New(policy Policy, users application.Roles) (v1.Client, error) {
	d := directory{bindings: map[application.Actor][]string{}, users: users}
	for _, binding := range policy.Bindings {
		actor := application.Actor{Kind: binding.Kind, ID: binding.ID}
		if (actor.Kind != "service" && actor.Kind != "operator") || actor.ID == "" || len(binding.Roles) == 0 {
			return nil, application.ErrInvalid
		}
		if _, exists := d.bindings[actor]; exists {
			return nil, application.ErrInvalid
		}
		for _, role := range binding.Roles {
			if role == "" {
				return nil, application.ErrInvalid
			}
		}
		d.bindings[actor] = append([]string(nil), binding.Roles...)
	}
	engine, err := application.New(d, policy.Rules, policy.Version)
	if err != nil {
		return nil, err
	}
	return local.Client{Service: engine}, nil
}

func Load(path string) (v1.Client, error) {
	var policy Policy
	if err := configjson.Read(path, 1<<20, &policy); err != nil {
		return nil, err
	}
	if len(policy.Bindings) == 0 || len(policy.Rules) == 0 {
		return nil, fmt.Errorf("authorization policy requires bindings and rules")
	}
	return New(policy, nil)
}
