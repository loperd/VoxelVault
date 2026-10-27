package application

import (
	"context"
	"encoding/json"
	"github.com/voxel-vault/api/inventory/domain"
)

type Request struct {
	Owner, RequestID, ItemID string
	Action                   domain.Action
}

// Pricing is an Inventory-owned pure policy, evaluated on the locked item. It must not
// perform network settlement or query another context inside the local transaction.
type Pricing interface {
	Quote(domain.Item, domain.Action) (domain.Quote, error)
}
type Tx interface {
	ClaimOperation(id, owner, fingerprint string) (*domain.Operation, error)
	LockOperation(id, owner string) (domain.Operation, error)
	LockItem(id, owner string) (domain.Item, error)
	Save(domain.Operation, domain.Item) error
	Enqueue(domain.SettlementCommand) error
	Inbox(id, fingerprint string) (bool, error)
}
type Store interface {
	Transact(context.Context, func(Tx) error) error
	Operation(context.Context, string, string) (domain.Operation, error)
}
type Service struct {
	store   Store
	pricing Pricing
	auth    Authorizer
}

func New(store Store, pricing Pricing, auth Authorizer) (*Service, error) {
	if auth == nil {
		return nil, ErrForbidden
	}
	if store == nil || pricing == nil {
		return nil, domain.ErrInvalid
	}
	return &Service{store: store, pricing: pricing, auth: auth}, nil
}
func (s *Service) Start(ctx context.Context, r Request) (domain.Operation, error) {
	permission := Permission("")
	switch r.Action {
	case domain.Repair:
		permission = RepairItem
	case domain.Sell:
		permission = SellItem
	case domain.Salvage:
		permission = SalvageItem
	default:
		return domain.Operation{}, domain.ErrInvalid
	}
	var authorizationErr error
	ctx, authorizationErr = authorize(ctx, s.auth, permission, Resource{Kind: "item", ID: r.ItemID, Owner: r.Owner})
	if authorizationErr != nil {
		return domain.Operation{}, authorizationErr
	}
	if !domain.ValidID(r.Owner) || !domain.ValidID(r.RequestID) || !domain.ValidID(r.ItemID) {
		return domain.Operation{}, domain.ErrInvalid
	}
	id := domain.Identity("operation", r.Owner, r.RequestID)
	ctx = withLifecycle(ctx, "workshop_start", id, r)
	raw, _ := json.Marshal(r)
	fingerprint := domain.Identity(string(raw))
	var result domain.Operation
	err := s.store.Transact(ctx, func(tx Tx) error {
		prior, err := tx.ClaimOperation(id, r.Owner, fingerprint)
		if err != nil {
			return err
		}
		if prior != nil {
			if prior.ID != id || prior.Owner != r.Owner || prior.ItemID != r.ItemID || prior.Action != r.Action {
				return domain.ErrConflict
			}
			result = *prior
			return nil
		}
		item, err := tx.LockItem(r.ItemID, r.Owner)
		if err != nil {
			return err
		}
		if item.ID != r.ItemID || item.Owner != r.Owner {
			return domain.ErrNotFound
		}
		quote, err := s.pricing.Quote(item, r.Action)
		if err != nil {
			return err
		}
		transition, err := domain.Begin(item, r.RequestID, r.Action, quote)
		if err != nil {
			return err
		}
		if err := save(tx, transition); err != nil {
			return err
		}
		result = transition.Operation
		return nil
	})
	return result, err
}
func (s *Service) Cancel(ctx context.Context, owner, id string) (domain.Operation, error) {
	var authorizationErr error
	ctx, authorizationErr = authorize(ctx, s.auth, CancelOperation, Resource{Kind: "operation", ID: id, Owner: owner})
	if authorizationErr != nil {
		return domain.Operation{}, authorizationErr
	}
	if !domain.ValidID(owner) || !domain.ValidID(id) {
		return domain.Operation{}, domain.ErrInvalid
	}
	ctx = withLifecycle(ctx, "workshop_cancel", id, map[string]string{"owner": owner, "operation": id})
	var result domain.Operation
	err := s.store.Transact(ctx, func(tx Tx) error {
		op, err := tx.LockOperation(id, owner)
		if err != nil {
			return err
		}
		if op.ID != id || op.Owner != owner {
			return domain.ErrNotFound
		}
		item, err := tx.LockItem(op.ItemID, owner)
		if err != nil {
			return err
		}
		if item.ID != op.ItemID || item.Owner != op.Owner {
			return domain.ErrNotFound
		}
		transition, err := op.Cancel(item)
		if err != nil {
			return err
		}
		if err := save(tx, transition); err != nil {
			return err
		}
		result = transition.Operation
		return nil
	})
	return result, err
}

// Observe is an inbound integration use case. A trusted adapter authenticates the event
// source before calling it. Inbox identity and the local transition share one commit.
func (s *Service) Observe(ctx context.Context, messageID string, fact domain.SettlementFact) error {
	var authorizationErr error
	ctx, authorizationErr = authorize(ctx, s.auth, ObserveSettlement, Resource{Kind: "operation", ID: fact.IntentID})
	if authorizationErr != nil {
		return authorizationErr
	}
	if !domain.ValidID(messageID) || !domain.ValidID(fact.IntentID) {
		return domain.ErrInvalid
	}
	raw, _ := json.Marshal(fact)
	fingerprint := domain.Identity(string(raw))
	ctx = withLifecycle(ctx, "settlement_observed", messageID, fact)
	return s.store.Transact(ctx, func(tx Tx) error {
		duplicate, err := tx.Inbox(messageID, fingerprint)
		if err != nil || duplicate {
			return err
		}
		op, err := tx.LockOperation(fact.IntentID, "")
		if err != nil {
			return err
		}
		if op.ID != fact.IntentID || !domain.ValidID(op.Owner) {
			return domain.ErrNotFound
		}
		item, err := tx.LockItem(op.ItemID, op.Owner)
		if err != nil {
			return err
		}
		if item.ID != op.ItemID || item.Owner != op.Owner {
			return domain.ErrNotFound
		}
		transition, err := op.Observe(item, fact)
		if err != nil {
			return err
		}
		return save(tx, transition)
	})
}
func (s *Service) Reconcile(ctx context.Context, id, reason string) error {
	var authorizationErr error
	ctx, authorizationErr = authorize(ctx, s.auth, ReconcileOperation, Resource{Kind: "operation", ID: id})
	if authorizationErr != nil {
		return authorizationErr
	}
	ctx = withLifecycle(ctx, "reconciliation", id, map[string]string{"operation": id, "reason": reason})
	return s.store.Transact(ctx, func(tx Tx) error {
		op, err := tx.LockOperation(id, "")
		if err != nil {
			return err
		}
		if op.ID != id || !domain.ValidID(op.Owner) {
			return domain.ErrNotFound
		}
		item, err := tx.LockItem(op.ItemID, op.Owner)
		if err != nil {
			return err
		}
		if item.ID != op.ItemID || item.Owner != op.Owner {
			return domain.ErrNotFound
		}
		transition, err := op.Reconcile(item, reason)
		if err != nil {
			return err
		}
		return save(tx, transition)
	})
}
func (s *Service) Operation(ctx context.Context, owner, id string) (domain.Operation, error) {
	var err error
	ctx, err = authorize(ctx, s.auth, ReadOperation, Resource{Kind: "operation", ID: id, Owner: owner})
	if err != nil {
		return domain.Operation{}, err
	}
	if !domain.ValidID(owner) || !domain.ValidID(id) {
		return domain.Operation{}, domain.ErrInvalid
	}
	op, err := s.store.Operation(ctx, owner, id)
	if err == nil && (op.Owner != owner || op.ID != id) {
		return domain.Operation{}, domain.ErrNotFound
	}
	return op, err
}
func save(tx Tx, t domain.Transition) error {
	if !t.Changed {
		return nil
	}
	if err := tx.Save(t.Operation, t.Item); err != nil {
		return err
	}
	if t.Next != nil {
		return tx.Enqueue(*t.Next)
	}
	return nil
}
