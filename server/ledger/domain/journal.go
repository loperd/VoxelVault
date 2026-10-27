package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"time"
)

// Identity hashes an unambiguous tuple; separators embedded in IDs cannot collide.
func Identity(parts ...string) string {
	b, _ := json.Marshal(parts)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

type Account struct{ ID, Subject, Asset, Role string }

func PlayerAccount(t Terms) Account {
	return Account{Identity("player", t.Subject, t.Asset), t.Subject, t.Asset, "player_liability"}
}

func TreasuryAccount(treasury, asset string) Account {
	return Account{Identity("treasury", treasury, asset), treasury, asset, "treasury_liability"}
}
func CounterAccount(t Terms, action Action) Account {
	role := "reward_expense"
	if action == Capture {
		role = "spending_income"
	} else if t.Purpose == OpeningBalance {
		role = "opening_equity"
	}
	return Account{Identity("system", role, t.Asset), "system", t.Asset, role}
}

type Side string

const (
	Dr Side = "debit"
	Cr Side = "credit"
)

type Posting struct {
	Account, Asset string
	Side           Side
	Units          int64
}
type Journal struct {
	ID, Producer, IntentID, Asset string
	At                            time.Time
	Postings                      []Posting
}

func (j Journal) Validate() error {
	if !ValidID(j.ID) || !ValidID(j.Producer) || !ValidID(j.IntentID) || !ValidID(j.Asset) || j.At.IsZero() || len(j.Postings) < 2 {
		return ErrInvalid
	}
	sum := new(big.Int)
	accounts := map[string]bool{}
	for _, p := range j.Postings {
		if !ValidID(p.Account) || p.Asset != j.Asset || p.Units <= 0 {
			return ErrInvalid
		}
		accounts[p.Account] = true
		n := big.NewInt(p.Units)
		switch p.Side {
		case Dr:
			sum.Add(sum, n)
		case Cr:
			sum.Sub(sum, n)
		default:
			return ErrInvalid
		}
	}
	if len(accounts) < 2 || sum.Sign() != 0 {
		return ErrInvariant
	}
	return nil
}
func SettlementJournal(i Intent, action Action, at time.Time) (Journal, error) {
	if i.Terms == nil || !((action == Capture && i.State == Captured) || ((action == Credit || action == Payout) && i.State == Credited)) {
		return Journal{}, ErrInvalid
	}
	t := *i.Terms
	if i.Kind == FundedAward && action != Payout {
		return Journal{}, ErrInvalid
	}
	p, c := PlayerAccount(t), CounterAccount(t, action)
	if action == Payout {
		if i.Kind != FundedAward || t.Validate(Payout) != nil {
			return Journal{}, ErrInvalid
		}
		c = TreasuryAccount(t.Treasury, t.Asset)
	}
	dr, cr := c.ID, p.ID
	if action == Capture {
		dr, cr = p.ID, c.ID
	}
	j := Journal{ID: Identity("journal", i.Producer, i.ID), Producer: i.Producer, IntentID: i.ID, Asset: t.Asset, At: at, Postings: []Posting{{dr, t.Asset, Dr, t.Units}, {cr, t.Asset, Cr, t.Units}}}
	return j, j.Validate()
}
