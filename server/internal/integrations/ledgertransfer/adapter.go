// Package ledgertransfer translates published contracts into Ledger-owned ports.
package ledgertransfer

import (
	"context"
	"errors"

	fv1 "github.com/voxel-vault/api/internal/commissions/contracts/v1"
	cv1 "github.com/voxel-vault/api/internal/currency/contracts/v1"
	iv1 "github.com/voxel-vault/api/internal/identity/contracts/v1"
	"github.com/voxel-vault/api/internal/ledger/application"
	"github.com/voxel-vault/api/internal/ledger/domain"
)

type Currency struct{ Client cv1.Provider }

func currencyError(err error) error {
	var public *cv1.Error
	if errors.As(err, &public) {
		switch public.Code {
		case "invalid":
			return domain.ErrInvalid
		case "forbidden":
			return application.ErrForbidden
		}
	}
	return err
}

func (c Currency) Describe(ctx context.Context, id string) (application.CurrencyDescriptor, error) {
	d, e := c.Client.Describe(ctx, id)
	return application.CurrencyDescriptor{
		ID:        d.ID,
		Code:      d.Code,
		Name:      d.Name,
		Revision:  d.Revision,
		Precision: d.Precision,
		Active:    d.Active,
	}, currencyError(e)
}

func (c Currency) Decide(
	ctx context.Context,
	subject, id string,
) (application.AccessDecision, error) {
	d, e := c.Client.Decide(ctx, subject, id)
	return application.AccessDecision{
		CanRead:    d.CanRead,
		CanOperate: d.CanOperate,
		Revision:   d.Revision,
	}, currencyError(e)
}

type RecipientResolver struct{ Client iv1.RecipientResolver }

func (c RecipientResolver) ResolveRecipient(
	ctx context.Context,
	query string,
) (application.Recipient, error) {
	p, e := c.Client.ResolveRecipient(ctx, query)
	if e != nil {
		var public *iv1.Error
		if errors.As(e, &public) && (public.Code == "invalid" || public.Code == "conflict") {
			return application.Recipient{}, domain.ErrInvalid
		}
		return application.Recipient{}, e
	}
	return application.Recipient{ID: p.ID, Handle: p.Handle, DisplayName: p.DisplayName}, nil
}

type Calculator struct{ Client fv1.Calculator }

func (c Calculator) CalculateTransfer(
	ctx context.Context,
	f application.TransferFact,
) (application.CommissionPlan, error) {
	p, e := c.Client.CalculateTransfer(
		ctx,
		fv1.TransferFact{
			CurrencyID:    f.CurrencyID,
			SenderID:      f.SenderID,
			RecipientID:   f.RecipientID,
			OriginalUnits: f.OriginalUnits,
			Precision:     f.Precision,
		},
	)
	if e != nil {
		var public *fv1.Error
		if errors.As(e, &public) {
			switch public.Code {
			case "invalid":
				return application.CommissionPlan{}, domain.ErrInvalid
			case "forbidden":
				return application.CommissionPlan{}, application.ErrForbidden
			}
		}
		return application.CommissionPlan{}, e
	}
	result := application.CommissionPlan{
		Version:      p.Version,
		DebitUnits:   p.DebitUnits,
		ReceiptUnits: p.ReceiptUnits,
		Commission:   []application.Commission{},
	}
	for _, fee := range p.Commission {
		v := application.Commission{
			RuleID:     fee.RuleID,
			Version:    fee.Version,
			Imposition: fee.Imposition,
			Units:      fee.Units,
			Allocation: []application.Allocation{},
		}
		for _, a := range fee.Allocation {
			v.Allocation = append(
				v.Allocation,
				application.Allocation{AccountRef: a.AccountRef, Burn: a.Burn, Units: a.Units},
			)
		}
		result.Commission = append(result.Commission, v)
	}
	return result, nil
}
