package application

import (
	"context"
	"errors"
	"math"
	"strconv"
	"time"

	"github.com/voxel-vault/api/ledger/domain"
)

var (
	ErrQuoteExpired      = errors.New("transfer quote expired")
	ErrTransferFunds     = errors.New("insufficient transfer funds")
	ErrTransferNotFound  = errors.New("transfer not found")
	ErrTransferRateLimit = errors.New("transfer quote rate limit exceeded")
	ErrTransferBurst     = errors.New("too many confirmed transfers")
)

type CurrencyDescriptor struct {
	ID, Code, Name, Revision string
	Precision                uint8
	Active                   bool
}
type AccessDecision struct {
	CanRead, CanOperate bool
	Revision            string
}
type TransferCurrency interface {
	Describe(context.Context, string) (CurrencyDescriptor, error)
	Decide(context.Context, string, string) (AccessDecision, error)
}
type Recipient struct {
	ID          string `json:"id"`
	Handle      string `json:"handle"`
	DisplayName string `json:"displayName"`
}
type RecipientResolver interface {
	ResolveRecipient(context.Context, string) (Recipient, error)
}
type TransferFact struct {
	CurrencyID, SenderID, RecipientID, OriginalUnits string
	Precision                                        uint8
}
type Allocation struct {
	AccountRef string `json:"accountRef,omitempty"`
	Burn       bool   `json:"burn,omitempty"`
	Units      string `json:"units"`
}
type Commission struct {
	RuleID     string       `json:"ruleId"`
	Version    string       `json:"version"`
	Imposition string       `json:"imposition"`
	Units      string       `json:"units"`
	Allocation []Allocation `json:"allocation"`
}
type CommissionPlan struct {
	Version, DebitUnits, ReceiptUnits string
	Commission                        []Commission
}
type CommissionCalculator interface {
	CalculateTransfer(context.Context, TransferFact) (CommissionPlan, error)
}
type TransferAuthorizer interface {
	AuthorizeTransfer(context.Context, string, string) error
}
type TransferQuote struct {
	ID             string       `json:"id"`
	SenderID       string       `json:"senderId"`
	Recipient      Recipient    `json:"recipient"`
	CurrencyID     string       `json:"currencyId"`
	Code           string       `json:"code"`
	Precision      uint8        `json:"precision"`
	OriginalUnits  string       `json:"originalUnits"`
	DebitUnits     string       `json:"debitUnits"`
	ReceiptUnits   string       `json:"receiptUnits"`
	Commission     []Commission `json:"commission"`
	RuleVersion    string       `json:"ruleVersion"`
	AccessRevision string       `json:"accessRevision"`
	ExpiresAt      time.Time    `json:"expiresAt"`
}
type TransferReceipt struct {
	TransferID   string `json:"transferId"`
	JournalID    string `json:"journalId"`
	CurrencyID   string `json:"currencyId"`
	State        string `json:"state"`
	DebitUnits   string `json:"debitUnits"`
	ReceiptUnits string `json:"receiptUnits"`
}
type TransferTx interface {
	Tx
	ClaimTransfer(string, string, string) (*TransferReceipt, error)
	CheckTransferKey(string, string, string) error
	LockTransferQuote(string, string) (TransferQuote, *TransferReceipt, error)
	Account(string) (domain.Account, bool, error)
	CompleteTransfer(string, string, string, TransferReceipt) error
	// CheckTransferAllowed runs with both accounts locked: restrictions and the per-minute burst cap.
	CheckTransferAllowed(subject, sender, recipient string) error
}
type TransferStore interface {
	SaveTransferQuote(context.Context, TransferQuote) error
	TransferQuote(context.Context, string, string) (TransferQuote, *TransferReceipt, error)
	Transfer(context.Context, func(TransferTx) error) error
	TransferDestination(context.Context, string) (domain.Account, bool, error)
	// CheckRestrictions refuses a quote for a blocked sender or recipient (see CheckTransferAllowed).
	CheckRestrictions(ctx context.Context, sender, recipient string) error
	// SuspendSender writes a time-limited send restriction after a rejected burst.
	SuspendSender(ctx context.Context, account string) error
}
type TransferService struct {
	Store      TransferStore
	Currency   TransferCurrency
	Recipient  RecipientResolver
	Commission CommissionCalculator
	Authorizer TransferAuthorizer
	Clock      func() time.Time
	ID         func() (string, error)
}

func NewTransfer(
	store TransferStore,
	currency TransferCurrency,
	recipient RecipientResolver,
	commission CommissionCalculator,
	auth TransferAuthorizer,
	clock func() time.Time,
	id func() (string, error),
) (*TransferService, error) {
	if store == nil || currency == nil || recipient == nil || commission == nil || auth == nil ||
		clock == nil ||
		id == nil {
		return nil, domain.ErrInvalid
	}
	return &TransferService{store, currency, recipient, commission, auth, clock, id}, nil
}

func transferUnits(s string) (int64, error) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 || strconv.FormatInt(n, 10) != s {
		return 0, domain.ErrInvalid
	}
	return n, nil
}

func (s *TransferService) scope(ctx context.Context, currency string) (string, error) {
	p, ok := AuthenticatedPrincipal(ctx)
	if !ok || !domain.ValidID(p.ID) || !domain.ValidID(currency) {
		return "", ErrForbidden
	}
	if err := s.Authorizer.AuthorizeTransfer(ctx, p.ID, currency); err != nil {
		return "", err
	}
	return p.ID, nil
}

func (s *TransferService) access(ctx context.Context, subject, recipient, asset string) error {
	for _, id := range []string{subject, recipient} {
		a, err := s.Currency.Decide(ctx, id, asset)
		if err != nil {
			return err
		}
		if !a.CanOperate {
			return ErrForbidden
		}
	}
	return nil
}

func (s *TransferService) ResolveRecipient(
	ctx context.Context,
	asset, query string,
) (Recipient, error) {
	sender, err := s.scope(ctx, asset)
	if err != nil {
		return Recipient{}, err
	}
	access, err := s.Currency.Decide(ctx, sender, asset)
	if err != nil {
		return Recipient{}, err
	}
	if !access.CanOperate {
		return Recipient{}, ErrForbidden
	}
	r, err := s.Recipient.ResolveRecipient(ctx, query)
	if err != nil {
		return r, err
	}
	a, err := s.Currency.Decide(ctx, r.ID, asset)
	if err != nil {
		return Recipient{}, err
	}
	if !a.CanOperate {
		return Recipient{}, ErrForbidden
	}
	return r, nil
}

func (s *TransferService) Quote(
	ctx context.Context,
	asset, recipientQuery, amount string,
) (TransferQuote, error) {
	var q TransferQuote
	sender, err := s.scope(ctx, asset)
	if err != nil {
		return q, err
	}
	if _, err = transferUnits(amount); err != nil {
		return q, err
	}
	r, err := s.Recipient.ResolveRecipient(ctx, recipientQuery)
	if err != nil {
		return q, err
	}
	if !domain.ValidID(r.ID) || r.ID == sender {
		return q, domain.ErrInvalid
	}
	d, err := s.Currency.Describe(ctx, asset)
	if err != nil {
		return q, err
	}
	if d.ID != asset || d.Precision > 18 || !d.Active {
		return q, domain.ErrInvalid
	}
	if err = s.access(ctx, sender, r.ID, asset); err != nil {
		return q, err
	}
	if err = s.Store.CheckRestrictions(ctx, domain.PlayerAccount(domain.Terms{Subject: sender, Asset: asset}).ID, domain.PlayerAccount(domain.Terms{Subject: r.ID, Asset: asset}).ID); err != nil {
		return q, err
	}
	p, err := s.Commission.CalculateTransfer(
		ctx,
		TransferFact{asset, sender, r.ID, amount, d.Precision},
	)
	if err != nil {
		return q, err
	}
	id, err := s.ID()
	if err != nil {
		return q, err
	}
	now := s.Clock().UTC()
	if !domain.ValidID(id) || now.IsZero() {
		return q, domain.ErrInvalid
	}
	q = TransferQuote{
		ID:             id,
		SenderID:       sender,
		Recipient:      r,
		CurrencyID:     asset,
		Code:           d.Code,
		Precision:      d.Precision,
		OriginalUnits:  amount,
		DebitUnits:     p.DebitUnits,
		ReceiptUnits:   p.ReceiptUnits,
		Commission:     p.Commission,
		RuleVersion:    p.Version,
		AccessRevision: d.Revision,
		ExpiresAt:      now.Add(time.Minute),
	}
	if _, err = validateTransfer(q); err != nil {
		return TransferQuote{}, err
	}
	for _, c := range q.Commission {
		for _, a := range c.Allocation {
			if a.Burn {
				continue
			}
			account, active, err := s.Store.TransferDestination(ctx, a.AccountRef)
			if err != nil {
				return TransferQuote{}, err
			}
			if !active || account.Asset != asset || account.Role != "treasury_liability" {
				return TransferQuote{}, domain.ErrInvalid
			}
		}
	}
	if err = s.Store.SaveTransferQuote(ctx, q); err != nil {
		return TransferQuote{}, err
	}
	return q, nil
}

// validateTransfer validates a calculator result without trusting a caller's totals.
func validateTransfer(q TransferQuote) (map[string]int64, error) {
	a, err := transferUnits(q.OriginalUnits)
	if err != nil {
		return nil, err
	}
	debit, receipt := a, a
	dest := map[string]int64{}
	if q.RuleVersion == "" || len(q.Commission) == 0 || len(q.Commission) > 100 {
		return nil, domain.ErrInvalid
	}
	seen := map[string]bool{}
	for _, c := range q.Commission {
		if c.RuleID == "" || c.Version == "" || seen[c.RuleID] || len(c.Allocation) > 100 {
			return nil, domain.ErrInvalid
		}
		seen[c.RuleID] = true
		u, e := strconv.ParseInt(c.Units, 10, 64)
		if e != nil || u < 0 || strconv.FormatInt(u, 10) != c.Units {
			return nil, domain.ErrInvalid
		}
		switch c.Imposition {
		case "inside":
			if u >= receipt {
				return nil, domain.ErrInvalid
			}
			receipt -= u
		case "outside":
			if u > math.MaxInt64-debit {
				return nil, domain.ErrInvalid
			}
			debit += u
		default:
			return nil, domain.ErrInvalid
		}
		sum := int64(0)
		for _, leg := range c.Allocation {
			n, e := transferUnits(leg.Units)
			if e != nil || n > u-sum {
				return nil, domain.ErrInvalid
			}
			sum += n
			key := leg.AccountRef
			if leg.Burn {
				if key != "" {
					return nil, domain.ErrInvalid
				}
				key = domain.Identity("burn", q.CurrencyID)
			} else if !domain.ValidID(key) {
				return nil, domain.ErrInvalid
			}
			if n > math.MaxInt64-dest[key] {
				return nil, domain.ErrInvalid
			}
			dest[key] += n
		}
		if sum != u {
			return nil, domain.ErrInvalid
		}
	}
	if q.DebitUnits != strconv.FormatInt(debit, 10) ||
		q.ReceiptUnits != strconv.FormatInt(receipt, 10) {
		return nil, domain.ErrInvariant
	}
	return dest, nil
}

func (s *TransferService) Confirm(
	ctx context.Context,
	quoteID, key string,
) (TransferReceipt, error) {
	var result TransferReceipt
	if !domain.ValidID(quoteID) || !domain.ValidID(key) {
		return result, domain.ErrInvalid
	}
	p, ok := AuthenticatedPrincipal(ctx)
	if !ok {
		return result, ErrForbidden
	}
	q, prior, err := s.Store.TransferQuote(ctx, quoteID, p.ID)
	if err != nil {
		return result, err
	}
	if _, err = s.scope(ctx, q.CurrencyID); err != nil {
		return result, err
	}
	fingerprint := domain.Identity("transfer", p.ID, quoteID)
	// Replays do not consume new keys, but a key bound to another quote still conflicts.
	if prior != nil {
		err = s.Store.Transfer(ctx, func(tx TransferTx) error {
			return tx.CheckTransferKey(p.ID, key, fingerprint)
		})
		if err != nil {
			return result, err
		}
		return *prior, nil
	}
	if prior == nil {
		d, e := s.Currency.Describe(ctx, q.CurrencyID)
		if e != nil {
			return result, e
		}
		if !d.Active || d.Precision != q.Precision {
			return result, ErrForbidden
		}
		if err = s.access(ctx, q.SenderID, q.Recipient.ID, q.CurrencyID); err != nil {
			return result, err
		}
		// A quote priced under another access revision or fee rule is stale, not honoured.
		if d.Revision != q.AccessRevision {
			return result, ErrQuoteExpired
		}
		plan, e := s.Commission.CalculateTransfer(
			ctx,
			TransferFact{q.CurrencyID, q.SenderID, q.Recipient.ID, q.OriginalUnits, q.Precision},
		)
		if e != nil {
			return result, e
		}
		if plan.Version != q.RuleVersion {
			return result, ErrQuoteExpired
		}
	}
	err = s.Store.Transfer(ctx, func(tx TransferTx) error {
		old, e := tx.ClaimTransfer(p.ID, key, fingerprint)
		if e != nil {
			return e
		}
		if old != nil {
			result = *old
			return nil
		}
		locked, done, e := tx.LockTransferQuote(quoteID, p.ID)
		if e != nil {
			return e
		}
		q = locked
		if done != nil {
			result = *done
			return tx.CompleteTransfer(p.ID, key, quoteID, result)
		}
		now := s.Clock().UTC()
		if !now.Before(q.ExpiresAt) {
			return ErrQuoteExpired
		}
		dest, e := validateTransfer(q)
		if e != nil {
			return e
		}
		sender := domain.PlayerAccount(domain.Terms{Subject: q.SenderID, Asset: q.CurrencyID})
		recipient := domain.PlayerAccount(
			domain.Terms{Subject: q.Recipient.ID, Asset: q.CurrencyID},
		)
		accounts := []domain.Account{sender, recipient}
		for id := range dest {
			if id == domain.Identity("burn", q.CurrencyID) {
				accounts = append(
					accounts,
					domain.Account{
						ID:      id,
						Subject: "system",
						Asset:   q.CurrencyID,
						Role:    "burn_equity",
					},
				)
				continue
			}
			a, active, e := tx.Account(id)
			if e != nil {
				return e
			}
			if !active || a.Asset != q.CurrencyID || a.Role != "treasury_liability" {
				return domain.ErrInvalid
			}
			accounts = append(accounts, a)
		}
		if e = tx.LockAccounts(accounts); e != nil {
			return e
		}
		for _, a := range accounts {
			_, active, e := tx.Account(a.ID)
			if e != nil {
				return e
			}
			if !active {
				return ErrForbidden
			}
		}
		if e = tx.CheckTransferAllowed(p.ID, sender.ID, recipient.ID); e != nil {
			return e
		}
		debit, _ := transferUnits(q.DebitUnits)
		received, _ := transferUnits(q.ReceiptUnits)
		funds, e := tx.Funds(sender.ID)
		if e != nil {
			return e
		}
		available, e := funds.Available()
		if e != nil {
			return e
		}
		if available < debit {
			return ErrTransferFunds
		}
		credits := map[string]int64{recipient.ID: received}
		for id, n := range dest {
			credits[id] = n
		}
		for id, n := range credits {
			f, e := tx.Funds(id)
			if e != nil {
				return e
			}
			if f.Posted < 0 || n > math.MaxInt64-f.Posted {
				return domain.ErrInvariant
			}
		}
		intent := domain.Intent{
			Producer: "user-transfer",
			ID:       q.ID,
			Kind:     "transfer",
			State:    domain.Captured,
			Version:  1,
			Terms: &domain.Terms{
				Subject:  q.SenderID,
				Asset:    q.CurrencyID,
				Units:    debit,
				Purpose:  "transfer",
				Evidence: q.ID,
			},
		}
		if _, e = tx.LockIntent(intent.Producer, intent.ID); e != nil {
			return e
		}
		if e = tx.SaveIntent(intent); e != nil {
			return e
		}
		j := domain.Journal{
			ID:       domain.Identity("journal", intent.Producer, intent.ID),
			Producer: intent.Producer,
			IntentID: intent.ID,
			Asset:    q.CurrencyID,
			At:       now,
			Postings: []domain.Posting{
				{Account: sender.ID, Asset: q.CurrencyID, Side: domain.Dr, Units: debit},
				{Account: recipient.ID, Asset: q.CurrencyID, Side: domain.Cr, Units: received},
			},
		}
		for id, n := range dest {
			j.Postings = append(
				j.Postings,
				domain.Posting{Account: id, Asset: q.CurrencyID, Side: domain.Cr, Units: n},
			)
		}
		if e = tx.AppendJournal(j); e != nil {
			return e
		}
		result = TransferReceipt{
			TransferID:   q.ID,
			JournalID:    j.ID,
			CurrencyID:   q.CurrencyID,
			State:        "committed",
			DebitUnits:   q.DebitUnits,
			ReceiptUnits: q.ReceiptUnits,
		}
		return tx.CompleteTransfer(p.ID, key, quoteID, result)
	})
	if errors.Is(err, ErrTransferBurst) {
		// The rejecting transaction rolled back; the block is written in its own short one.
		if e := s.Store.SuspendSender(ctx, domain.PlayerAccount(domain.Terms{Subject: p.ID, Asset: q.CurrencyID}).ID); e != nil {
			return result, e
		}
		return result, ErrTransferRateLimit
	}
	return result, err
}
