package application

import (
	"context"
	"errors"
	"strings"
)

var (
	ErrInvalid   = errors.New("invalid currency")
	ErrForbidden = errors.New("currency capability denied")
)

type Descriptor struct {
	ID, Code, Name, Revision string
	Precision                uint8
	Active                   bool
}
type Definition struct {
	Descriptor  Descriptor
	Everyone    bool
	User, Group []string
}
type AccessDecision struct {
	CanRead, CanOperate bool
	Revision            string
}
type GroupMembership interface {
	IsMember(context.Context, string, string) (bool, error)
}
type Authorizer interface {
	Authorize(context.Context, string) error
}
type Catalog struct {
	definition []Definition
	auth       Authorizer
	membership GroupMembership
}

func New(definition []Definition, auth Authorizer, membership GroupMembership) (*Catalog, error) {
	if auth == nil || len(definition) == 0 || len(definition) > 100 {
		return nil, ErrInvalid
	}
	seen := map[string]bool{}
	copyDefinition := append([]Definition(nil), definition...)
	for i, d := range copyDefinition {
		v := d.Descriptor
		if v.ID == "" || v.Code == "" || v.Name == "" || v.Revision == "" || v.Precision > 18 ||
			v.ID == "currency" && v.Precision != 0 ||
			seen[v.ID] ||
			len(d.Group) > 0 && membership == nil {
			return nil, ErrInvalid
		}
		seen[v.ID] = true
		for _, id := range append(append([]string(nil), d.User...), d.Group...) {
			if id == "" || len(id) > 160 || strings.TrimSpace(id) != id {
				return nil, ErrInvalid
			}
		}
		copyDefinition[i].User = append([]string(nil), d.User...)
		copyDefinition[i].Group = append([]string(nil), d.Group...)
	}
	return &Catalog{copyDefinition, auth, membership}, nil
}

func (c *Catalog) Describe(ctx context.Context, producer, id string) (Descriptor, error) {
	if err := c.auth.Authorize(ctx, producer); err != nil {
		return Descriptor{}, err
	}
	for _, d := range c.definition {
		if d.Descriptor.ID == id {
			return d.Descriptor, nil
		}
	}
	return Descriptor{}, ErrInvalid
}

func (c *Catalog) Decide(
	ctx context.Context,
	producer, subject, id string,
) (AccessDecision, error) {
	d, err := c.Describe(ctx, producer, id)
	if err != nil {
		return AccessDecision{}, err
	}
	if subject == "" || len(subject) > 160 {
		return AccessDecision{}, ErrInvalid
	}
	available := false
	for _, v := range c.definition {
		if v.Descriptor.ID != id {
			continue
		}
		available = v.Everyone
		for _, user := range v.User {
			available = available || user == subject
		}
		if !available {
			for _, group := range v.Group {
				ok, err := c.membership.IsMember(ctx, subject, group)
				if err != nil {
					return AccessDecision{}, err
				}
				if ok {
					available = true
					break
				}
			}
		}
	}
	return AccessDecision{available, d.Active && available, d.Revision}, nil
}

func (c *Catalog) List(ctx context.Context, producer, subject string) ([]Descriptor, error) {
	if err := c.auth.Authorize(ctx, producer); err != nil {
		return nil, err
	}
	result := []Descriptor{}
	for _, d := range c.definition {
		result = append(result, d.Descriptor)
	}
	return result, nil
}
