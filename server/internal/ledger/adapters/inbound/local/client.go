// Package local binds a published Wallet client to a producer authenticated by the
// composition/transport boundary. A future HTTP adapter can expose the same V1 DTOs.
package local

import (
	"context"
	"errors"
	"github.com/voxel-vault/api/internal/ledger/adapters/contract"
	"github.com/voxel-vault/api/internal/ledger/application"
	v1 "github.com/voxel-vault/api/internal/ledger/contracts/v1"
	"github.com/voxel-vault/api/internal/ledger/domain"
	"strconv"
)

type Client struct {
	service  *application.Service
	producer string
}

func New(service *application.Service, authenticatedProducer string) (*Client, error) {
	if service == nil || !domain.ValidID(authenticatedProducer) {
		return nil, domain.ErrInvalid
	}
	return &Client{service, authenticatedProducer}, nil
}
func (c *Client) Execute(ctx context.Context, request v1.Command) (v1.Receipt, error) {
	cmd := application.Command{Producer: c.producer, ID: request.ID, IntentID: request.IntentID, Action: domain.Action(request.Action)}
	if request.Terms != nil {
		units, err := domain.ParseUnits(request.Terms.Units)
		if err != nil {
			return v1.Receipt{}, publicError(err)
		}
		cmd.Terms = &domain.Terms{Subject: request.Terms.Subject, Asset: request.Terms.Asset, Units: units, Purpose: domain.Purpose(request.Terms.Purpose), Evidence: request.Terms.Evidence, Treasury: request.Terms.Treasury}
	}
	r, err := c.service.Execute(ctx, cmd)
	return contract.Receipt(r), publicError(err)
}
func (c *Client) Status(ctx context.Context, id string) (v1.Receipt, error) {
	r, err := c.service.Status(ctx, c.producer, id)
	return contract.Receipt(r), publicError(err)
}
func (c *Client) Balance(ctx context.Context, subject, asset string) (v1.Balance, error) {
	f, err := c.service.Balance(ctx, c.producer, subject, asset)
	if err != nil {
		return v1.Balance{}, publicError(err)
	}
	available, err := f.Available()
	if err != nil {
		return v1.Balance{}, publicError(err)
	}
	return v1.Balance{Posted: strconv.FormatInt(f.Posted, 10), Held: strconv.FormatInt(f.Held, 10), Available: strconv.FormatInt(available, 10)}, nil
}

func publicError(err error) error {
	if err == nil {
		return nil
	}
	code := v1.Unavailable
	switch {
	case errors.Is(err, domain.ErrInvalid):
		code = v1.Invalid
	case errors.Is(err, domain.ErrConflict):
		code = v1.Conflict
	case errors.Is(err, domain.ErrNotReady):
		code = v1.NotReady
	case errors.Is(err, application.ErrForbidden):
		code = v1.Forbidden
	}
	return &v1.Error{Code: code}
}
