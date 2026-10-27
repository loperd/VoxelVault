package application

import (
	"context"

	"github.com/voxel-vault/api/ledger/domain"
)

type AccountAuthorizer interface {
	AuthorizeAccount(context.Context, string) error
}
type AccountStore interface {
	OpenAccount(context.Context, domain.Account) error
}
type AccountService struct {
	Store      AccountStore
	Authorizer AccountAuthorizer
}

func (s AccountService) Open(ctx context.Context, a domain.Account) error {
	if s.Store == nil || s.Authorizer == nil || !domain.ValidID(a.ID) ||
		!domain.ValidID(a.Subject) ||
		!domain.ValidID(a.Asset) ||
		a.Role != "treasury_liability" || a != domain.TreasuryAccount(a.Subject, a.Asset) {
		return domain.ErrInvalid
	}
	if err := s.Authorizer.AuthorizeAccount(ctx, a.ID); err != nil {
		return err
	}
	return s.Store.OpenAccount(ctx, a)
}
