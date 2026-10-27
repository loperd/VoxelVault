package local

import (
	"context"
	"errors"

	"github.com/voxel-vault/api/internal/ledger/application"
	v1 "github.com/voxel-vault/api/internal/ledger/contracts/v1"
)

type TransferClient struct{ Service *application.TransferService }

func transferError(err error) error {
	switch {
	case errors.Is(err, application.ErrTransferRateLimit):
		return &v1.Error{Code: v1.RateLimited}
	case errors.Is(err, application.ErrQuoteExpired):
		return &v1.Error{Code: "quote_expired"}
	case errors.Is(err, application.ErrTransferFunds):
		return &v1.Error{Code: "insufficient_funds"}
	case errors.Is(err, application.ErrTransferNotFound):
		return &v1.Error{Code: "not_found"}
	default:
		return publicError(err)
	}
}

func (c TransferClient) ResolveRecipient(
	ctx context.Context,
	asset, query string,
) (v1.Recipient, error) {
	p, err := c.Service.ResolveRecipient(ctx, asset, query)
	return v1.Recipient{ID: p.ID, Handle: p.Handle, DisplayName: p.DisplayName}, transferError(err)
}

func (c TransferClient) QuoteTransfer(
	ctx context.Context,
	asset, recipient, amount string,
) (v1.Quote, error) {
	q, err := c.Service.Quote(ctx, asset, recipient, amount)
	if err != nil {
		return v1.Quote{}, transferError(err)
	}
	r := v1.Quote{
		ID: q.ID,
		Recipient: v1.Recipient{
			ID:          q.Recipient.ID,
			Handle:      q.Recipient.Handle,
			DisplayName: q.Recipient.DisplayName,
		},
		CurrencyID:    q.CurrencyID,
		Code:          q.Code,
		Precision:     q.Precision,
		OriginalUnits: q.OriginalUnits,
		DebitUnits:    q.DebitUnits,
		ReceiptUnits:  q.ReceiptUnits,
		RuleVersion:   q.RuleVersion,
		ExpiresAt:     q.ExpiresAt,
		Commission:    []v1.Commission{},
	}
	for _, f := range q.Commission {
		c := v1.Commission{
			RuleID:     f.RuleID,
			Version:    f.Version,
			Imposition: f.Imposition,
			Units:      f.Units,
			Allocation: []v1.Allocation{},
		}
		for _, a := range f.Allocation {
			c.Allocation = append(
				c.Allocation,
				v1.Allocation{AccountRef: a.AccountRef, Burn: a.Burn, Units: a.Units},
			)
		}
		r.Commission = append(r.Commission, c)
	}
	return r, nil
}

func (c TransferClient) ConfirmTransfer(
	ctx context.Context,
	quote, key string,
) (v1.TransferReceipt, error) {
	r, err := c.Service.Confirm(ctx, quote, key)
	return v1.TransferReceipt{
			TransferID:   r.TransferID,
			JournalID:    r.JournalID,
			CurrencyID:   r.CurrencyID,
			State:        r.State,
			DebitUnits:   r.DebitUnits,
			ReceiptUnits: r.ReceiptUnits,
		}, transferError(
			err,
		)
}
