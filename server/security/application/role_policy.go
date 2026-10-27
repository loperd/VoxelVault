package application

import (
	"path"
	"sort"
)

type RoleDefinition struct {
	ID          string       `json:"id"`
	Parents     []string     `json:"parents,omitempty"`
	Permissions []Permission `json:"permissions"`
}
type RolePolicySpec struct {
	Version string           `json:"version"`
	Roles   []RoleDefinition `json:"roles"`
}

// RolePolicy is a validated, immutable permission snapshot. Bindings remain
// mutable Security data; policy definitions are trusted versioned configuration.
type RolePolicy struct {
	version string
	roles   map[string][]Permission
	catalog []Permission
}

func NewRolePolicy(spec RolePolicySpec) (*RolePolicy, error) {
	if !validText(spec.Version, 64) || len(spec.Roles) == 0 || len(spec.Roles) > 1024 {
		return nil, ErrInvalid
	}
	definitions := map[string]RoleDefinition{}
	for _, role := range spec.Roles {
		if !validID(role.ID) {
			return nil, ErrInvalid
		}
		if _, ok := definitions[role.ID]; ok {
			return nil, ErrInvalid
		}
		for _, p := range role.Permissions {
			if !validText(p.Resource, 2048) || !validID(p.Action) {
				return nil, ErrInvalid
			}
			if _, err := path.Match(p.Resource, ""); err != nil {
				return nil, ErrInvalid
			}
		}
		definitions[role.ID] = role
	}
	out := &RolePolicy{version: spec.Version, roles: map[string][]Permission{}}
	visiting := map[string]bool{}
	var compile func(string) ([]Permission, error)
	compile = func(id string) ([]Permission, error) {
		if p, ok := out.roles[id]; ok {
			return p, nil
		}
		role, ok := definitions[id]
		if !ok || visiting[id] {
			return nil, ErrInvalid
		}
		visiting[id] = true
		all := append([]Permission(nil), role.Permissions...)
		for _, parent := range role.Parents {
			p, err := compile(parent)
			if err != nil {
				return nil, err
			}
			all = append(all, p...)
		}
		visiting[id] = false
		out.roles[id] = uniquePermissions(all)
		return out.roles[id], nil
	}
	var all []Permission
	for id := range definitions {
		p, err := compile(id)
		if err != nil {
			return nil, err
		}
		all = append(all, p...)
	}
	out.catalog = uniquePermissions(all)
	return out, nil
}
func uniquePermissions(input []Permission) []Permission {
	seen := map[Permission]bool{}
	out := []Permission{}
	for _, p := range input {
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Resource == out[j].Resource {
			return out[i].Action < out[j].Action
		}
		return out[i].Resource < out[j].Resource
	})
	return out
}
func (p *RolePolicy) HasRole(id string) bool {
	if p == nil {
		return false
	}
	_, ok := p.roles[id]
	return ok
}
func (p *RolePolicy) Permissions(roles []string) []Permission {
	if p == nil {
		return []Permission{}
	}
	var out []Permission
	for _, role := range roles {
		out = append(out, p.roles[role]...)
	}
	return uniquePermissions(out)
}
func (p *RolePolicy) Catalog() []Permission {
	if p == nil {
		return []Permission{}
	}
	return append([]Permission{}, p.catalog...)
}
func (p *RolePolicy) Allows(roles []string, resource, action string) bool {
	for _, permission := range p.Permissions(roles) {
		if permission.Action == action {
			if match, err := path.Match(permission.Resource, resource); err == nil && match {
				return true
			}
		}
	}
	return false
}
