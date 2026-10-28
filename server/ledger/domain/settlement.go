// Package domain owns Wallet accounting and settlement rules. It has no dependencies on
// other bounded contexts, persistence, transport or authentication implementations.
package domain

import (
	"errors"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

var (
	ErrInvalid   = errors.New("invalid wallet command")
	ErrConflict  = errors.New("wallet intent conflicts with its existing purpose or terms")
	ErrNotReady  = errors.New("wallet intent is not ready; retry the same command")
	ErrInvariant = errors.New("wallet funds invariant violated")
	// ErrAccountNotOpen: treasury accounts are opened explicitly, never by a posting.
	ErrAccountNotOpen = errors.New("treasury account is not open")
)

type Action string

const (
	Reserve      Action = "reserve"
	Capture      Action = "capture"
	Cancel       Action = "cancel"
	Credit       Action = "credit"
	Close        Action = "close"
	Payout       Action = "payout"
	ClosePayout  Action = "close_payout"
	FundTreasury Action = "fund_treasury"
)

type State string

const (
	Missing  State = "missing"
	Reserved State = "reserved"
	Captured State = "captured"
	Canceled State = "canceled"
	Declined State = "declined"
	Credited State = "credited"
	Rejected State = "rejected"
	Closed   State = "closed"
)

type Kind string

const (
	Debit       Kind = "debit"
	Award       Kind = "award"
	FundedAward Kind = "payout"
)

type Purpose string

const (
	Spending        Purpose = "spending"
	Reward          Purpose = "reward"
	OpeningBalance  Purpose = "opening_balance"
	Buyback         Purpose = "buyback"
	TreasuryOpening Purpose = "treasury_opening"
	TaxSweep        Purpose = "tax_sweep"
	Allocation      Purpose = "allocation"
)

type Terms struct {
	Subject  string
	Asset    string
	Units    int64
	Purpose  Purpose
	Evidence string
	Treasury string `json:",omitempty"`
}

func ValidID(s string) bool {
	return utf8.ValidString(s) && len(s) > 0 && len(s) <= 160 && strings.TrimSpace(s) == s && !strings.ContainsAny(s, "\x00\r\n")
}
func (t Terms) Validate(action Action) error {
	if !ValidID(t.Subject) || !ValidID(t.Asset) || !ValidID(t.Evidence) || t.Units <= 0 {
		return ErrInvalid
	}
	if action == Payout {
		if t.Purpose != Buyback || !ValidID(t.Treasury) {
			return ErrInvalid
		}
		return nil
	}
	if t.Treasury != "" {
		return ErrInvalid
	}
	if action == Reserve && t.Purpose != Spending {
		return ErrInvalid
	}
	if action == Credit && t.Purpose != Reward && t.Purpose != OpeningBalance {
		return ErrInvalid
	}
	return nil
}

// ParseUnits accepts a canonical positive decimal integer, never an imprecise float.
func ParseUnits(s string) (int64, error) {
	if len(s) == 0 || len(s) > 19 || s[0] < '1' || s[0] > '9' {
		return 0, ErrInvalid
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, ErrInvalid
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, ErrInvalid
	}
	return n, nil
}

type Funds struct{ Posted, Held int64 }

func (f Funds) Available() (int64, error) {
	if f.Posted < 0 || f.Held < 0 || f.Held > f.Posted {
		return 0, ErrInvariant
	}
	return f.Posted - f.Held, nil
}

type Intent struct {
	Producer, ID string
	Kind         Kind
	State        State
	Terms        *Terms
	Version      uint64
	Reason       string
}

func (i Intent) Clone() Intent {
	if i.Terms != nil {
		t := *i.Terms
		i.Terms = &t
	}
	return i
}
func kind(action Action) (Kind, error) {
	switch action {
	case Reserve, Capture, Cancel:
		return Debit, nil
	case Credit, Close:
		return Award, nil
	case Payout, ClosePayout:
		return FundedAward, nil
	}
	return "", ErrInvalid
}

// Apply is a pure decision. The caller must serialize the intent and funds read through
// its Wallet-local unit of work. A canceled/closed unseen intent is a durable fence.
func (i Intent) Apply(action Action, terms *Terms, funds Funds) (Intent, bool, error) {
	k, err := kind(action)
	if err != nil {
		return i, false, err
	}
	if k == FundedAward {
		return i, false, ErrInvalid
	}
	if i.Kind != "" && i.Kind != k {
		return i, false, ErrConflict
	}
	if action == Reserve || action == Credit {
		if terms == nil {
			return i, false, ErrInvalid
		}
		if err := terms.Validate(action); err != nil {
			return i, false, err
		}
		if i.Terms != nil && *i.Terms != *terms {
			return i, false, ErrConflict
		}
	} else if terms != nil {
		return i, false, ErrInvalid
	}
	next := i.Clone()
	next.Kind = k
	if next.State == "" {
		next.State = Missing
	}
	if next.State == Missing && (action == Reserve || action == Credit) {
		t := *terms
		next.Terms = &t
	}
	switch action {
	case Reserve:
		if next.State == Missing {
			available, e := funds.Available()
			if e != nil {
				return i, false, e
			}
			if available < terms.Units {
				next.State = Declined
				next.Reason = "insufficient_funds"
			} else {
				next.State = Reserved
			}
		}
	case Capture:
		if next.State == Missing {
			return i, false, ErrNotReady
		}
		if next.State == Reserved {
			if next.Terms == nil {
				return i, false, ErrInvariant
			}
			if _, e := funds.Available(); e != nil {
				return i, false, e
			}
			if funds.Held < next.Terms.Units {
				return i, false, ErrInvariant
			}
			next.State = Captured
		}
	case Cancel:
		if next.State == Missing || next.State == Reserved || next.State == Declined {
			next.State = Canceled
		}
	case Credit:
		if next.State == Missing {
			if _, e := funds.Available(); e != nil {
				return i, false, e
			}
			if terms.Units > math.MaxInt64-funds.Posted {
				next.State = Rejected
				next.Reason = "balance_limit"
			} else {
				next.State = Credited
			}
		}
	case Close:
		if next.State == Missing || next.State == Rejected {
			next.State = Closed
		}
	}
	changed := next.State != i.State && !(i.State == "" && next.State == Missing)
	if !changed {
		return i.Clone(), false, nil
	}
	if i.Version == math.MaxUint64 {
		return i, false, ErrInvariant
	}
	next.Version = i.Version + 1
	return next, true, nil
}

// ApplyPayout is an atomic funded transfer decision. The application locks both
// liability accounts before observing funds; no reward-expense account funds it.
func (i Intent) ApplyPayout(action Action, terms *Terms, payer, recipient Funds) (Intent, bool, error) {
	if action != Payout && action != ClosePayout {
		return i, false, ErrInvalid
	}
	if i.Kind != "" && i.Kind != FundedAward {
		return i, false, ErrConflict
	}
	switch i.State {
	case "", Missing, Credited, Rejected, Closed:
	default:
		return i, false, ErrInvariant
	}
	if action == Payout {
		if terms == nil {
			return i, false, ErrInvalid
		}
		if err := terms.Validate(action); err != nil {
			return i, false, err
		}
		if i.Terms != nil && *i.Terms != *terms {
			return i, false, ErrConflict
		}
	} else if terms != nil {
		return i, false, ErrInvalid
	}
	next := i.Clone()
	next.Kind = FundedAward
	if next.State == "" {
		next.State = Missing
	}
	if action == Payout && next.State == Missing {
		t := *terms
		next.Terms = &t
		available, err := payer.Available()
		if err != nil {
			return i, false, err
		}
		if _, err = recipient.Available(); err != nil {
			return i, false, err
		}
		switch {
		case available < t.Units:
			next.State = Rejected
			next.Reason = "insufficient_treasury_funds"
		case t.Units > math.MaxInt64-recipient.Posted:
			next.State = Rejected
			next.Reason = "balance_limit"
		default:
			next.State = Credited
		}
	} else if action == ClosePayout && (next.State == Missing || next.State == Rejected) {
		next.State = Closed
	}
	changed := next.State != i.State && !(i.State == "" && next.State == Missing)
	if !changed {
		return i.Clone(), false, nil
	}
	if i.Version == math.MaxUint64 {
		return i, false, ErrInvariant
	}
	next.Version = i.Version + 1
	return next, true, nil
}
