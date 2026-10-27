package local

import (
	"context"
	"errors"
	"strconv"

	"github.com/voxel-vault/api/internal/commissions/application"
	v1 "github.com/voxel-vault/api/internal/commissions/contracts/v1"
	"github.com/voxel-vault/api/internal/commissions/domain"
)

type Calculator struct {
	Service  *application.Calculator
	Producer string
}

func publicError(err error) error {
	switch {
	case errors.Is(err, domain.ErrInvalid):
		return &v1.Error{Code: "invalid"}
	case errors.Is(err, application.ErrForbidden):
		return &v1.Error{Code: "forbidden"}
	default:
		return err
	}
}

func (c Calculator) CalculateTransfer(ctx context.Context, f v1.TransferFact) (v1.Plan, error) {
	n, err := application.ParseUnits(f.OriginalUnits)
	if err != nil {
		return v1.Plan{}, publicError(err)
	}
	p, version, err := c.Service.Calculate(
		ctx,
		c.Producer,
		application.TransferFact{
			CurrencyID:  f.CurrencyID,
			SenderID:    f.SenderID,
			RecipientID: f.RecipientID,
			Units:       n,
			Precision:   f.Precision,
		},
	)
	if err != nil {
		return v1.Plan{}, publicError(err)
	}
	r := v1.Plan{
		Version:      version,
		DebitUnits:   strconv.FormatInt(p.Debit, 10),
		ReceiptUnits: strconv.FormatInt(p.Receipt, 10),
		Commission:   []v1.Commission{},
	}
	for _, fee := range p.Commission {
		c := v1.Commission{
			RuleID:     fee.RuleID,
			Version:    fee.Version,
			Imposition: fee.Imposition,
			Units:      strconv.FormatInt(fee.Units, 10),
			Allocation: []v1.Allocation{},
		}
		for _, a := range fee.Allocation {
			c.Allocation = append(
				c.Allocation,
				v1.Allocation{
					AccountRef: a.Account,
					Burn:       a.Burn,
					Units:      strconv.FormatInt(a.Units, 10),
				},
			)
		}
		r.Commission = append(r.Commission, c)
	}
	return r, nil
}
