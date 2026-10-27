// Package authorization implements an explicit, deny-by-default capability policy.
package authorization

import (
	"context"
	"github.com/voxel-vault/api/internal/ledger/application"
	"github.com/voxel-vault/api/internal/ledger/domain"
)

type Grant struct {
	Producer         string
	Actions          []domain.Action
	Assets, Subjects []string
	Purposes         []domain.Purpose
	AllSubjects      bool
	Treasuries       []string
	Scopes           []ResourceScope
	MaxUnits         int64
}
type ResourceScope struct {
	Purpose domain.Purpose
	Assets  []string
}
type rule struct {
	actions          map[domain.Action]bool
	assets, subjects map[string]bool
	purposes         map[domain.Purpose]bool
	allSubjects      bool
	treasuries       map[string]bool
	scopes           map[domain.Purpose]map[string]bool
	maxUnits         int64
}
type Policy struct{ rules map[string]rule }

func New(grants []Grant) (*Policy, error) {
	p := &Policy{rules: map[string]rule{}}
	for _, g := range grants {
		if !domain.ValidID(g.Producer) || g.Producer == "user-transfer" || len(g.Actions) == 0 || len(g.Assets) == 0 || (!g.AllSubjects && len(g.Subjects) == 0) {
			return nil, domain.ErrInvalid
		}
		if _, exists := p.rules[g.Producer]; exists {
			return nil, domain.ErrConflict
		}
		r := rule{actions: map[domain.Action]bool{}, assets: map[string]bool{}, subjects: map[string]bool{}, purposes: map[domain.Purpose]bool{}, allSubjects: g.AllSubjects, treasuries: map[string]bool{}}
		if g.MaxUnits < 0 {
			return nil, domain.ErrInvalid
		}
		r.maxUnits = g.MaxUnits
		for _, a := range g.Actions {
			switch a {
			case domain.Reserve, domain.Capture, domain.Cancel, domain.Credit, domain.Close, domain.Payout, domain.ClosePayout, domain.FundTreasury, application.ReadCapability:
				r.actions[a] = true
			default:
				return nil, domain.ErrInvalid
			}
		}
		for _, a := range g.Assets {
			if !domain.ValidID(a) {
				return nil, domain.ErrInvalid
			}
			r.assets[a] = true
		}
		for _, s := range g.Subjects {
			if !domain.ValidID(s) {
				return nil, domain.ErrInvalid
			}
			r.subjects[s] = true
		}
		for _, purpose := range g.Purposes {
			switch purpose {
			case domain.Spending, domain.Reward, domain.OpeningBalance, domain.Buyback, domain.TreasuryOpening:
				r.purposes[purpose] = true
			default:
				return nil, domain.ErrInvalid
			}
		}
		for _, treasury := range g.Treasuries {
			if !domain.ValidID(treasury) {
				return nil, domain.ErrInvalid
			}
			r.treasuries[treasury] = true
		}
		if r.actions[domain.Payout] || r.actions[domain.FundTreasury] {
			if len(r.treasuries) == 0 {
				return nil, domain.ErrInvalid
			}
		}
		if len(g.Scopes) > 0 {
			// An explicit purpose matrix is deny-by-default for every omitted pair.
			r.scopes = map[domain.Purpose]map[string]bool{}
			for _, scope := range g.Scopes {
				if !r.purposes[scope.Purpose] || len(scope.Assets) == 0 || r.scopes[scope.Purpose] != nil {
					return nil, domain.ErrInvalid
				}
				allowed := map[string]bool{}
				for _, asset := range scope.Assets {
					if !r.assets[asset] {
						return nil, domain.ErrInvalid
					}
					allowed[asset] = true
				}
				r.scopes[scope.Purpose] = allowed
			}
		}
		p.rules[g.Producer] = r
		if r.actions[domain.FundTreasury] && r.maxUnits <= 0 {
			return nil, domain.ErrInvalid
		}
	}
	return p, nil
}
func (p *Policy) Authorize(ctx context.Context, producer string, action domain.Action, terms *domain.Terms) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if p == nil {
		return application.ErrForbidden
	}
	r, exists := p.rules[producer]
	if !exists || !r.actions[action] {
		return application.ErrForbidden
	}
	if terms != nil {
		if action != application.ReadCapability && r.maxUnits > 0 && terms.Units > r.maxUnits {
			return application.ErrForbidden
		}
		if !r.assets[terms.Asset] || (!r.allSubjects && !r.subjects[terms.Subject]) {
			return application.ErrForbidden
		}
		if action != application.ReadCapability && !r.purposes[terms.Purpose] {
			return application.ErrForbidden
		}
		if terms.Treasury != "" && !r.treasuries[terms.Treasury] {
			return application.ErrForbidden
		}
		if action != application.ReadCapability && r.scopes != nil && !r.scopes[terms.Purpose][terms.Asset] {
			return application.ErrForbidden
		}
	}
	return nil
}
