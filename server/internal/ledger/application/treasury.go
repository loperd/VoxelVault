package application

import (
	"context"
	"time"

	"github.com/voxel-vault/api/internal/ledger/domain"
)

// TreasuryOpening is a one-time, explicitly authorized allocation. A replay after
// spending returns its old receipt and never replenishes the treasury.
type TreasuryOpening struct {
	Treasury, Asset, Source, Reference string
	Units                              int64
}
type TreasuryOpeningStore interface {
	OpenTreasury(context.Context, string, TreasuryOpening, time.Time) (Receipt, error)
}
type TreasuryOpeningService struct {
	Store      TreasuryOpeningStore
	Authorizer Authorizer
	Producer   string
	Clock      func() time.Time
}

func (s TreasuryOpeningService) Open(ctx context.Context, input TreasuryOpening) (Receipt, error) {
	if s.Store == nil || s.Authorizer == nil || s.Clock == nil || !domain.ValidID(s.Producer) || !domain.ValidID(input.Treasury) || !domain.ValidID(input.Asset) || !domain.ValidID(input.Source) || !domain.ValidID(input.Reference) || input.Units <= 0 {
		return Receipt{}, domain.ErrInvalid
	}
	terms := domain.Terms{Subject: "system", Treasury: input.Treasury, Asset: input.Asset, Units: input.Units, Purpose: domain.TreasuryOpening, Evidence: domain.Identity("treasury-funding", input.Source, input.Reference)}
	if err := s.Authorizer.Authorize(ctx, s.Producer, domain.FundTreasury, &terms); err != nil {
		return Receipt{}, err
	}
	if err := authorizeIssuance(ctx, s.Authorizer, s.Producer, Issuance{Purpose: domain.TreasuryOpening, Source: input.Source, Reference: input.Reference, Treasury: input.Treasury, Totals: map[string]int64{input.Asset: input.Units}}); err != nil {
		return Receipt{}, err
	}
	at := s.Clock().UTC()
	if at.IsZero() {
		return Receipt{}, domain.ErrInvalid
	}
	return s.Store.OpenTreasury(ctx, s.Producer, input, at)
}
