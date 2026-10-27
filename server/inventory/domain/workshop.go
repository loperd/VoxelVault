// Package domain owns item work and its settlement process. It does not import Wallet,
// persistence, published provider DTOs or another context's domain model.
package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"
)

var (
	ErrInvalid  = errors.New("invalid inventory operation")
	ErrConflict = errors.New("inventory operation conflicts with persisted state")
	ErrBusy     = errors.New("item is reserved by another operation")
	ErrNotFound = errors.New("inventory item or operation not found")
)

func ValidID(s string) bool {
	return utf8.ValidString(s) && len(s) > 0 && len(s) <= 160 && strings.TrimSpace(s) == s && !strings.ContainsAny(s, "\x00\r\n")
}
func Identity(parts ...string) string {
	b, _ := json.Marshal(parts)
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

type Action string

const (
	Repair  Action = "repair"
	Sell    Action = "sell"
	Salvage Action = "salvage"
)

type Item struct {
	ID, Owner, Definition, Condition, Origin string
	Status                                   string
	OperationID                              string
}

const (
	Available = "available"
	Locked    = "locked"
	Consumed  = "consumed"
)

var conditions = []string{"intact", "slight", "heavy", "broken"}

func rank(condition string) int {
	for n, s := range conditions {
		if condition == s {
			return n
		}
	}
	return -1
}

type Quote struct {
	Asset    string
	Units    int64
	Revision string
}
type Stage string

const (
	AwaitFunds      Stage = "awaiting_funds"
	RepairCommitted Stage = "repair_committed"
	AwaitAward      Stage = "awaiting_award"
	Canceling       Stage = "canceling"
	Closing         Stage = "closing"
	Completed       Stage = "completed"
	Canceled        Stage = "canceled"
	Restored        Stage = "restored"
	Reconciliation  Stage = "reconciliation_required"
)

type Operation struct {
	ID, Owner, ItemID, RequestID string
	Action                       Action
	Quote                        Quote
	Before                       string
	Stage                        Stage
	Version                      uint64
	WalletVersion                uint64
	WalletOutcome                Outcome
	Reason                       string
}
type Step string

const (
	ReserveCost Step = "reserve_cost"
	CaptureCost Step = "capture_cost"
	CancelCost  Step = "cancel_cost"
	AwardValue  Step = "award_value"
	CloseAward  Step = "close_award"
	FundSale    Step = "fund_sale"
	CloseSale   Step = "close_sale"
)

type SettlementCommand struct {
	ID, IntentID, Owner string
	Step                Step
	Quote               Quote
	Evidence            string
}

func (o Operation) Command(step Step) SettlementCommand {
	if o.Action == Sell {
		if step == AwardValue {
			step = FundSale
		}
		if step == CloseAward {
			step = CloseSale
		}
	}
	return SettlementCommand{ID: Identity("command", o.ID, string(step)), IntentID: o.ID, Owner: o.Owner, Step: step, Quote: o.Quote, Evidence: o.Evidence()}
}
func (o Operation) Evidence() string {
	return Identity("quote", o.ID, o.Quote.Revision, o.Quote.Asset, strconv.FormatInt(o.Quote.Units, 10))
}

type Outcome string

const (
	FundsHeld     Outcome = "funds_held"
	FundsDeclined Outcome = "funds_declined"
	DebitRecorded Outcome = "debit_recorded"
	DebitCanceled Outcome = "debit_canceled"
	AwardRecorded Outcome = "award_recorded"
	AwardRejected Outcome = "award_rejected"
	AwardClosed   Outcome = "award_closed"
)

type SettlementTerms struct {
	Owner, Asset, Evidence string
	Units                  int64
	Purpose                string
}
type SettlementFact struct {
	Reason   string
	IntentID string
	Version  uint64
	Outcome  Outcome
	Terms    *SettlementTerms
}
type Transition struct {
	Operation Operation
	Item      Item
	Next      *SettlementCommand
	Changed   bool
}

func Begin(item Item, requestID string, action Action, quote Quote) (Transition, error) {
	if !ValidID(item.ID) || !ValidID(item.Owner) || !ValidID(item.Definition) || !ValidID(requestID) || rank(item.Condition) < 0 || !ValidID(quote.Asset) || !ValidID(quote.Revision) || quote.Units <= 0 {
		return Transition{}, ErrInvalid
	}
	if item.Status != Available || item.OperationID != "" {
		return Transition{}, ErrBusy
	}
	if action != Repair && action != Sell && action != Salvage {
		return Transition{}, ErrInvalid
	}
	if action == Repair && rank(item.Condition) == 0 {
		return Transition{}, ErrInvalid
	}
	op := Operation{ID: Identity("operation", item.Owner, requestID), Owner: item.Owner, ItemID: item.ID, RequestID: requestID, Action: action, Quote: quote, Before: item.Condition, Version: 1}
	item.OperationID = op.ID
	step := ReserveCost
	if action == Repair {
		op.Stage = AwaitFunds
		item.Status = Locked
	} else {
		op.Stage = AwaitAward
		item.Status = Consumed
		step = AwardValue
	}
	command := op.Command(step)
	return Transition{op, item, &command, true}, nil
}
func (o Operation) Cancel(item Item) (Transition, error) {
	result := Transition{Operation: o, Item: item}
	if o.Stage == Canceled || o.Stage == Canceling {
		return result, nil
	}
	if o.Action != Repair || o.Stage != AwaitFunds {
		return result, ErrConflict
	}
	if item.OperationID != o.ID || item.Status != Locked {
		return result, ErrConflict
	}
	result.Operation.Stage = Canceling
	result.Operation.Reason = "user_requested"
	result.Operation.Version++
	c := o.Command(CancelCost)
	result.Next = &c
	result.Changed = true
	return result, nil
}
func (o Operation) Observe(item Item, f SettlementFact) (Transition, error) {
	result := Transition{Operation: o, Item: item}
	if f.IntentID != o.ID || f.Version == 0 {
		return result, ErrInvalid
	}
	expectedPurpose := "reward"
	if o.Action == Sell {
		expectedPurpose = "buyback"
	}
	if o.Action == Repair {
		expectedPurpose = "spending"
	}
	if f.Terms != nil {
		if *f.Terms != (SettlementTerms{Owner: o.Owner, Asset: o.Quote.Asset, Units: o.Quote.Units, Evidence: o.Evidence(), Purpose: expectedPurpose}) {
			return result, ErrConflict
		}
	} else if f.Outcome != DebitCanceled && f.Outcome != AwardClosed {
		return result, ErrInvalid
	}
	switch f.Outcome {
	case FundsHeld, FundsDeclined, DebitRecorded, DebitCanceled:
		if o.Action != Repair {
			return result, ErrConflict
		}
	case AwardRecorded, AwardRejected, AwardClosed:
		if o.Action == Repair {
			return result, ErrConflict
		}
	default:
		return result, ErrInvalid
	}
	if f.Version < o.WalletVersion {
		return result, nil
	}
	if f.Version == o.WalletVersion {
		if f.Outcome != o.WalletOutcome {
			return result, ErrConflict
		}
		return result, nil
	}
	if o.Stage == Reconciliation {
		return result, ErrConflict
	}
	if o.Stage == Completed || o.Stage == Canceled || o.Stage == Restored {
		if f.Outcome != o.WalletOutcome {
			return result, ErrConflict
		}
		return result, nil
	}
	if item.OperationID != o.ID {
		return result, ErrConflict
	}
	op := o
	op.WalletVersion = f.Version
	op.WalletOutcome = f.Outcome
	op.Version++
	result.Operation = op
	result.Changed = true
	queue := func(step Step) { command := op.Command(step); result.Next = &command }
	if o.Action == Repair {
		switch f.Outcome {
		case FundsHeld:
			if o.Stage == AwaitFunds {
				r := rank(item.Condition)
				if r <= 0 || item.Condition != o.Before || item.Status != Locked {
					return Transition{}, ErrConflict
				}
				result.Item.Condition = conditions[r-1]
				result.Operation.Stage = RepairCommitted
				queue(CaptureCost)
			} // A late reserve acknowledgment while canceling never commits repair.
		case FundsDeclined:
			if o.Stage == RepairCommitted {
				return Transition{}, ErrConflict
			}
			result.Operation.Stage = Canceling
			result.Operation.Reason = f.Reason
			queue(CancelCost)
		case DebitCanceled:
			if o.Stage == RepairCommitted {
				return Transition{}, ErrConflict
			}
			result.Operation.Stage = Canceled
			result.Item.OperationID = ""
			result.Item.Status = Available
		case DebitRecorded:
			if o.Stage != RepairCommitted {
				return Transition{}, ErrConflict
			}
			result.Operation.Stage = Completed
			result.Item.OperationID = ""
			result.Item.Status = Available
		}
	} else {
		switch f.Outcome {
		case AwardRecorded:
			result.Operation.Stage = Completed
		case AwardRejected:
			result.Operation.Stage = Closing
			result.Operation.Reason = f.Reason
			queue(CloseAward)
		case AwardClosed:
			result.Operation.Stage = Restored
			result.Item.Status = Available
			result.Item.OperationID = ""
		}
	}
	return result, nil
}
func (o Operation) Reconcile(item Item, reason string) (Transition, error) {
	if o.Stage == Completed || o.Stage == Canceled || o.Stage == Restored {
		return Transition{Operation: o, Item: item}, nil
	}
	if o.Stage == Reconciliation {
		return Transition{Operation: o, Item: item}, nil
	}
	if item.OperationID != o.ID {
		return Transition{}, ErrConflict
	}
	o.Stage = Reconciliation
	o.Reason = reason
	o.Version++
	return Transition{Operation: o, Item: item, Changed: true}, nil
}
