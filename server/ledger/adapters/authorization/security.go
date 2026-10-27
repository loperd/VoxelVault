package authorization

import (
	"context"
	"fmt"
	"strconv"

	"github.com/voxel-vault/api/ledger/application"
	"github.com/voxel-vault/api/ledger/domain"
	v1 "github.com/voxel-vault/api/security/contracts/v1"
)

// Binding authenticates a producer at composition time. It cannot be supplied in
// a settlement DTO. User reads instead require the verified request principal.
type Binding struct{ Producer, Kind, ID string }

type Security struct {
	policy         *Policy
	client         v1.Client
	bindings       map[string]Binding
	userProducer   string
	issuanceClient v1.Client
}

func WithSecurity(policy *Policy, client v1.Client, userProducer string, bindings []Binding, issuance ...v1.Client) (*Security, error) {
	if policy == nil || client == nil || (userProducer != "" && !domain.ValidID(userProducer)) {
		return nil, domain.ErrInvalid
	}
	s := &Security{policy: policy, client: client, bindings: map[string]Binding{}, userProducer: userProducer}
	if len(issuance) > 1 {
		return nil, domain.ErrInvalid
	}
	if len(issuance) == 1 {
		s.issuanceClient = issuance[0]
	}
	for _, b := range bindings {
		if !domain.ValidID(b.Producer) || !domain.ValidID(b.ID) || (b.Kind != "service" && b.Kind != "operator") || b.Producer == userProducer {
			return nil, domain.ErrInvalid
		}
		if _, exists := s.bindings[b.Producer]; exists {
			return nil, domain.ErrConflict
		}
		s.bindings[b.Producer] = b
	}
	return s, nil
}

func (s *Security) AuthorizeIssuance(ctx context.Context, producer string, request application.Issuance) error {
	if s == nil || s.issuanceClient == nil {
		return application.ErrForbidden
	}
	b, ok := s.bindings[producer]
	if !ok || b.Kind != "operator" {
		return application.ErrForbidden
	}
	permission := "wallet.issue." + string(request.Purpose)
	r := v1.Request{Context: "wallet", ActorKind: b.Kind, ActorID: b.ID, Permission: permission, ResourceKind: "issuance", ResourceID: request.Source, Source: request.Source, Version: request.Reference, Attributes: map[string]string{"purpose": string(request.Purpose), "reference": request.Reference, "treasury": request.Treasury}}
	check := func() error {
		d, err := s.issuanceClient.Decide(ctx, r)
		if err != nil {
			return fmt.Errorf("wallet issuance authorization unavailable: %w", err)
		}
		if !d.Allowed || !domain.ValidID(d.PolicyVersion) {
			return application.ErrForbidden
		}
		return nil
	}
	// The envelope gate also covers empty baselines. Asset gates independently
	// constrain the aggregate allocation, preventing split-posting cap bypasses.
	if err := check(); err != nil {
		return err
	}
	r.Permission = permission + ".asset"
	for asset, units := range request.Totals {
		if units < 0 {
			return domain.ErrInvalid
		}
		r.Attributes["asset"], r.Attributes["units"] = asset, strconv.FormatInt(units, 10)
		if err := check(); err != nil {
			return err
		}
	}
	return nil
}

func (s *Security) Authorize(ctx context.Context, producer string, action domain.Action, terms *domain.Terms) error {
	if s == nil || s.policy == nil || s.client == nil {
		return application.ErrForbidden
	}
	if err := s.policy.Authorize(ctx, producer, action, terms); err != nil {
		return err
	}
	r := v1.Request{Context: "wallet", Permission: "wallet." + string(action), Source: producer}
	if s.userProducer != "" && producer == s.userProducer {
		p, ok := application.AuthenticatedPrincipal(ctx)
		if !ok || !domain.ValidID(p.ID) || action != application.ReadCapability || terms == nil || terms.Subject != p.ID {
			return application.ErrForbidden
		}
		r.ActorKind, r.ActorID = p.Kind, p.ID
		r.ResourceKind, r.ResourceID, r.Owner = "owner", terms.Subject, terms.Subject
	} else {
		b, ok := s.bindings[producer]
		if !ok {
			return application.ErrForbidden
		}
		r.ActorKind, r.ActorID = b.Kind, b.ID
		r.ResourceKind, r.ResourceID = "producer", b.ID
	}
	d, err := s.client.Decide(ctx, r)
	if err != nil {
		return fmt.Errorf("wallet authorization unavailable: %w", err)
	}
	if !d.Allowed || !domain.ValidID(d.PolicyVersion) {
		return application.ErrForbidden
	}
	return nil
}
