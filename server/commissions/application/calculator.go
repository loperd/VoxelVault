package application

import (
	"context"
	"errors"
	"strconv"

	"github.com/voxel-vault/api/commissions/domain"
)

var ErrForbidden = errors.New("commission capability denied")

type TransferFact struct {
	CurrencyID, SenderID, RecipientID string
	Units                             int64
	Precision                         uint8
}
type Authorizer interface {
	Authorize(context.Context, string, TransferFact) error
}
type Calculator struct {
	version string
	rule    []domain.Rule
	auth    Authorizer
}

func New(version string, rule []domain.Rule, auth Authorizer) (*Calculator, error) {
	if version == "" || len(rule) == 0 || auth == nil {
		return nil, domain.ErrInvalid
	}
	copyRule := append([]domain.Rule(nil), rule...)
	seen := map[string]bool{}
	for i, r := range copyRule {
		if err := r.Validate(); err != nil {
			return nil, err
		}
		if r.Currency == "" || seen[r.Currency+":"+r.ID] {
			return nil, domain.ErrInvalid
		}
		seen[r.Currency+":"+r.ID] = true
		copyRule[i].Destination = append([]domain.Destination(nil), r.Destination...)
	}
	return &Calculator{version, copyRule, auth}, nil
}

func (c *Calculator) Calculate(
	ctx context.Context,
	producer string,
	fact TransferFact,
) (domain.Plan, string, error) {
	if c == nil || c.auth == nil || fact.Units <= 0 || fact.Precision > 18 ||
		fact.CurrencyID == "" ||
		fact.SenderID == "" ||
		fact.RecipientID == "" {
		return domain.Plan{}, "", domain.ErrInvalid
	}
	if err := c.auth.Authorize(ctx, producer, fact); err != nil {
		return domain.Plan{}, "", err
	}
	rules := []domain.Rule{}
	for _, r := range c.rule {
		if r.Currency == fact.CurrencyID {
			rules = append(rules, r)
		}
	}
	p, err := domain.Calculate(fact.Units, rules)
	return p, c.version, err
}

func ParseUnits(s string) (int64, error) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 || strconv.FormatInt(n, 10) != s {
		return 0, domain.ErrInvalid
	}
	return n, nil
}
