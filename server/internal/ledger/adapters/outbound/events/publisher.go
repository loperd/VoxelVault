package events

import (
	"context"
	"errors"
	"github.com/voxel-vault/api/internal/ledger/adapters/contract"
	"github.com/voxel-vault/api/internal/ledger/application"
	v1 "github.com/voxel-vault/api/internal/ledger/contracts/v1"
)

type Publisher struct{ Sink v1.EventSink }

func (p Publisher) Publish(ctx context.Context, event application.Event) error {
	if p.Sink == nil {
		return errors.New("wallet event sink is required")
	}
	return p.Sink.Deliver(ctx, v1.Event{Version: 1, ID: event.ID, CorrelationID: event.Receipt.Intent.ID, CausationID: event.CausationID, Producer: event.Receipt.Intent.Producer, Receipt: contract.Receipt(event.Receipt)})
}
