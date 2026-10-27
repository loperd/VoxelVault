// Package application declares Wallet's use cases and outbound ports. Integrating contexts
// consume a published adapter contract, not these domain aggregates or repository ports.
package application

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/voxel-vault/api/ledger/domain"
)

var ErrForbidden = errors.New("wallet capability denied")
var errScopeChanged = errors.New("wallet authorization scope changed")

type Command struct {
	Producer, ID, IntentID string
	Action                 domain.Action
	Terms                  *domain.Terms
}
type Receipt struct {
	Intent    domain.Intent
	JournalID string
}
type Event struct {
	ID          string
	CausationID string
	Receipt     Receipt
	At          time.Time
}

// Authorizer receives a producer authenticated by an inbound adapter, never an untrusted
// browser field. It must check action, owner/asset scope and economic purpose.
type Authorizer interface {
	Authorize(context.Context, string, domain.Action, *domain.Terms) error
}

// Store commits only Wallet state. No transaction handle is exposed to other contexts.
type Store interface {
	Transact(context.Context, func(Tx) error) error
	ReadIntent(context.Context, string, string) (domain.Intent, error)
	Balance(context.Context, string, string) (domain.Funds, error)
}
type Tx interface {
	ClaimCommand(producer, id, fingerprint string) (*Receipt, error)
	LockIntent(producer, id string) (domain.Intent, error)
	LockAccounts([]domain.Account) error
	LockAccountsForRelease([]domain.Account) error
	Funds(account string) (domain.Funds, error)
	SaveIntent(domain.Intent) error
	AppendJournal(domain.Journal) error
	CompleteCommand(producer, id string, receipt Receipt) error
	Enqueue(Event) error
}
type Service struct {
	store Store
	auth  Authorizer
	clock func() time.Time
}

func New(store Store, auth Authorizer, clock func() time.Time) (*Service, error) {
	if store == nil || auth == nil || clock == nil {
		return nil, domain.ErrInvalid
	}
	return &Service{store, auth, clock}, nil
}

// ReadCapability authorizes subject/asset-scoped reads without pretending they are
// financial mutations. Inbound adapters authenticate producer and subject separately.
const ReadCapability domain.Action = "read"

func (s *Service) Status(ctx context.Context, producer, intentID string) (Receipt, error) {
	if !domain.ValidID(producer) || !domain.ValidID(intentID) {
		return Receipt{}, domain.ErrInvalid
	}
	if err := s.auth.Authorize(ctx, producer, ReadCapability, nil); err != nil {
		return Receipt{}, err
	}
	i, err := s.store.ReadIntent(ctx, producer, intentID)
	if err != nil {
		return Receipt{}, err
	}
	if err := s.auth.Authorize(ctx, producer, ReadCapability, i.Terms); err != nil {
		return Receipt{}, err
	}
	r := Receipt{Intent: i.Clone()}
	if i.State == domain.Captured || i.State == domain.Credited {
		r.JournalID = domain.Identity("journal", i.Producer, i.ID)
	}
	return r, nil
}

func (s *Service) Balance(ctx context.Context, producer, subject, asset string) (domain.Funds, error) {
	if !domain.ValidID(producer) || !domain.ValidID(subject) || !domain.ValidID(asset) {
		return domain.Funds{}, domain.ErrInvalid
	}
	scope := domain.Terms{Subject: subject, Asset: asset}
	if err := s.auth.Authorize(ctx, producer, ReadCapability, &scope); err != nil {
		return domain.Funds{}, err
	}
	f, err := s.store.Balance(ctx, subject, asset)
	if err == nil {
		_, err = f.Available()
	}
	return f, err
}
func (s *Service) Execute(ctx context.Context, input Command) (Receipt, error) {
	if input.Terms != nil {
		terms := *input.Terms
		input.Terms = &terms
	}
	// Scope can change once when a missing intent receives its immutable terms.
	// Roll back and obtain a new decision outside the transaction in that race.
	for attempt := 0; attempt < 2; attempt++ {
		r, err := s.execute(ctx, input)
		if !errors.Is(err, errScopeChanged) {
			return r, err
		}
	}
	return Receipt{}, domain.ErrNotReady
}

func (s *Service) execute(ctx context.Context, input Command) (Receipt, error) {
	// Copy request values so persistence never borrows caller-owned mutable pointers.
	c := input
	if c.Terms != nil {
		t := *c.Terms
		c.Terms = &t
	}
	if !domain.ValidID(c.Producer) || c.Producer == "user-transfer" || !domain.ValidID(c.ID) || !domain.ValidID(c.IntentID) {
		return Receipt{}, domain.ErrInvalid
	}
	switch c.Action {
	case domain.Reserve, domain.Credit, domain.Payout:
		if c.Terms == nil {
			return Receipt{}, domain.ErrInvalid
		}
		if err := c.Terms.Validate(c.Action); err != nil {
			return Receipt{}, err
		}
	case domain.Capture, domain.Cancel, domain.Close, domain.ClosePayout:
		if c.Terms != nil {
			return Receipt{}, domain.ErrInvalid
		}
	default:
		return Receipt{}, domain.ErrInvalid
	}
	if err := s.auth.Authorize(ctx, c.Producer, c.Action, c.Terms); err != nil {
		return Receipt{}, err
	}
	// Obtain decisions before the local transaction: Security may live remotely.
	// Terms are immutable once established. A concurrent first writer must retry
	// if it introduces scope that was not authorized by this entry snapshot.
	observed, err := s.store.ReadIntent(ctx, c.Producer, c.IntentID)
	if err != nil {
		return Receipt{}, err
	}
	if observed.Producer != c.Producer || observed.ID != c.IntentID {
		return Receipt{}, domain.ErrInvariant
	}
	if err := s.auth.Authorize(ctx, c.Producer, c.Action, observed.Terms); err != nil {
		return Receipt{}, err
	}
	permits := func(terms *domain.Terms) bool {
		return terms == nil || (c.Terms != nil && *terms == *c.Terms) || (observed.Terms != nil && *terms == *observed.Terms)
	}
	body, err := json.Marshal(c)
	if err != nil {
		return Receipt{}, err
	}
	fingerprint := domain.Identity(string(body))
	var result Receipt
	err = s.store.Transact(ctx, func(tx Tx) error {
		prior, e := tx.ClaimCommand(c.Producer, c.ID, fingerprint)
		if e != nil {
			return e
		}
		if prior != nil {
			// Authorization changes apply to retries too, including intents closed before terms existed.
			if !permits(prior.Intent.Terms) {
				return errScopeChanged
			}
			result = *prior
			return nil
		}
		current, e := tx.LockIntent(c.Producer, c.IntentID)
		if e != nil {
			return e
		}
		if !permits(current.Terms) {
			return errScopeChanged
		}
		terms := current.Terms
		if terms == nil {
			terms = c.Terms
		}
		var funds, payer domain.Funds
		if terms != nil {
			accounts := []domain.Account{domain.PlayerAccount(*terms)}
			if c.Action == domain.Payout || c.Action == domain.ClosePayout {
				accounts = append(accounts, domain.TreasuryAccount(terms.Treasury, terms.Asset))
			} else if c.Action == domain.Capture || c.Action == domain.Credit {
				accounts = append(accounts, domain.CounterAccount(*terms, c.Action))
			}
			if c.Action == domain.Cancel || c.Action == domain.Close || c.Action == domain.ClosePayout {
				if e := tx.LockAccountsForRelease(accounts); e != nil {
					return e
				}
			} else if e := tx.LockAccounts(accounts); e != nil {
				return e
			}
			funds, e = tx.Funds(accounts[0].ID)
			if e != nil {
				return e
			}
			if c.Action == domain.Payout || c.Action == domain.ClosePayout {
				payer, e = tx.Funds(accounts[1].ID)
				if e != nil {
					return e
				}
			}
		}
		var next domain.Intent
		var changed bool
		if c.Action == domain.Payout || c.Action == domain.ClosePayout {
			next, changed, e = current.ApplyPayout(c.Action, c.Terms, payer, funds)
		} else {
			next, changed, e = current.Apply(c.Action, c.Terms, funds)
		}
		if e != nil {
			return e
		}
		result = Receipt{Intent: next.Clone()}
		if next.State == domain.Captured || next.State == domain.Credited {
			result.JournalID = domain.Identity("journal", next.Producer, next.ID)
		}
		if changed {
			now := s.clock().UTC()
			if now.IsZero() {
				return domain.ErrInvalid
			}
			if (c.Action == domain.Capture && next.State == domain.Captured) || ((c.Action == domain.Credit || c.Action == domain.Payout) && next.State == domain.Credited) {
				journal, e := domain.SettlementJournal(next, c.Action, now)
				if e != nil {
					return e
				}
				if e = tx.AppendJournal(journal); e != nil {
					return e
				}
			}
			if e := tx.SaveIntent(next); e != nil {
				return e
			}
			event := Event{ID: domain.Identity("event", next.Producer, next.ID, string(next.State)), CausationID: c.ID, Receipt: result, At: now}
			if e := tx.Enqueue(event); e != nil {
				return e
			}
		}
		return tx.CompleteCommand(c.Producer, c.ID, result)
	})
	if err != nil {
		return Receipt{}, err
	}
	return result, nil
}
