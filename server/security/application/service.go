package application

import (
	"context"
	"errors"
	"math/big"
	"slices"
)

var ErrInvalid = errors.New("invalid security decision request")

type Actor struct{ Kind, ID string }
type Request struct {
	Actor                                                                                 Actor
	Permission, Context, ResourceKind, ResourceID, Owner, Source, Version, OperationScope string
	Attributes                                                                            map[string]string
}
type Decision struct {
	Allowed       bool
	PolicyVersion string
}
type Roles interface {
	Roles(context.Context, Actor) ([]string, error)
}
type Scope string

const (
	Self           Scope = "self"
	OwnerScope     Scope = "owner"
	OperationScope Scope = "operation"
	QueueScope     Scope = "queue"
	SourceScope    Scope = "source"
	IdentityScope  Scope = "identity"
	ResourceScope  Scope = "resource"
)

type Rule struct {
	Context      string                `json:"context"`
	ResourceIDs  []string              `json:"resourceIds,omitempty"`
	Role         string                `json:"role"`
	ActorKind    string                `json:"actorKind"`
	Permission   string                `json:"permission"`
	ResourceKind string                `json:"resourceKind"`
	Scope        Scope                 `json:"scope"`
	Sources      []string              `json:"sources,omitempty"`
	Attributes   map[string]Constraint `json:"attributes,omitempty"`
}

// Constraint requires an attribute to exist and satisfy every configured bound.
// Integer strings preserve precision across transports and domain contexts.
type Constraint struct {
	Values  []string `json:"values,omitempty"`
	Maximum string   `json:"maximum,omitempty"`
}

func natural(text string) (*big.Int, bool) {
	n, ok := new(big.Int).SetString(text, 10)
	return n, ok && n.Sign() >= 0 && n.String() == text
}

type Service struct {
	roles   Roles
	rules   []Rule
	version string
}

func New(roles Roles, rules []Rule, version string) (*Service, error) {
	if roles == nil || version == "" {
		return nil, ErrInvalid
	}
	out := make([]Rule, len(rules))
	copy(out, rules)
	for i := range out {
		if out[i].Context == "" || out[i].Role == "" || out[i].Permission == "" || out[i].ResourceKind == "" || (out[i].ActorKind != "user" && out[i].ActorKind != "service" && out[i].ActorKind != "operator") {
			return nil, ErrInvalid
		}
		switch out[i].Scope {
		case Self, OwnerScope, OperationScope, QueueScope, SourceScope, IdentityScope, ResourceScope:
		default:
			return nil, ErrInvalid
		}
		out[i].Sources = append([]string(nil), out[i].Sources...)
		out[i].ResourceIDs = append([]string(nil), out[i].ResourceIDs...)
		if out[i].Scope == ResourceScope && len(out[i].ResourceIDs) == 0 {
			return nil, ErrInvalid
		}
		attributes := map[string]Constraint{}
		for key, c := range out[i].Attributes {
			if key == "" || (len(c.Values) == 0 && c.Maximum == "") {
				return nil, ErrInvalid
			}
			if c.Maximum != "" {
				if _, ok := natural(c.Maximum); !ok {
					return nil, ErrInvalid
				}
			}
			c.Values = append([]string(nil), c.Values...)
			attributes[key] = c
		}
		out[i].Attributes = attributes
	}
	return &Service{roles: roles, rules: out, version: version}, nil
}
func (s *Service) Decide(ctx context.Context, r Request) (Decision, error) {
	if s == nil || s.roles == nil || s.version == "" {
		return Decision{}, ErrInvalid
	}
	denied := Decision{PolicyVersion: s.version}
	if err := ctx.Err(); err != nil {
		return denied, err
	}
	if r.Context == "" || r.Actor.ID == "" || r.ResourceID == "" || r.Permission == "" {
		return denied, ErrInvalid
	}
	roles, err := s.roles.Roles(ctx, r.Actor)
	if err != nil {
		return denied, err
	}
	for _, rule := range s.rules {
		if rule.Context != r.Context || rule.ActorKind != r.Actor.Kind || rule.Permission != r.Permission || rule.ResourceKind != r.ResourceKind {
			continue
		}
		assigned := false
		for _, role := range roles {
			if role == rule.Role {
				assigned = true
				break
			}
		}
		if !assigned {
			continue
		}
		matches := true
		for key, c := range rule.Attributes {
			value, exists := r.Attributes[key]
			if !exists || (len(c.Values) > 0 && !slices.Contains(c.Values, value)) {
				matches = false
				break
			}
			if c.Maximum != "" {
				n, ok := natural(value)
				maximum, _ := natural(c.Maximum)
				if !ok || n.Cmp(maximum) > 0 {
					matches = false
					break
				}
			}
		}
		if !matches {
			continue
		}
		allowed := false
		switch rule.Scope {
		case ResourceScope:
			allowed = slices.Contains(rule.ResourceIDs, r.ResourceID)
		case IdentityScope:
			allowed = (r.Actor.Kind == "service" || r.Actor.Kind == "operator") && r.ResourceID == r.Actor.ID && slices.Contains(rule.Sources, r.Source)
		case Self:
			allowed = r.Actor.Kind == "user" && r.Owner == r.Actor.ID
			if r.ResourceKind == "owner" {
				allowed = allowed && r.ResourceID == r.Owner
			}
		case OwnerScope:
			allowed = r.Owner != "" && slices.Contains(rule.Sources, r.Source)
		case OperationScope:
			allowed = r.Actor.Kind == "service" && r.ResourceID == r.OperationScope && r.OperationScope != ""
		case QueueScope:
			allowed = r.Actor.Kind == "service" && slices.Contains(rule.ResourceIDs, r.ResourceID)
		case SourceScope:
			for _, source := range rule.Sources {
				if source == r.Source && r.ResourceID == source && r.Version != "" {
					allowed = true
				}
			}
		}
		if allowed {
			return Decision{Allowed: true, PolicyVersion: s.version}, nil
		}
	}
	return denied, nil
}
