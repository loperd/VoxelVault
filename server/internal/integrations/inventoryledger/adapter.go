// Package inventoryledger translates Inventory's consumer port to Wallet's published
// V1 protocol. Neither context's domain/application imports the other context.
package inventoryledger

import (
	"context"
	"errors"
	inventory "github.com/voxel-vault/api/internal/inventory/application"
	"github.com/voxel-vault/api/internal/inventory/domain"
	v1 "github.com/voxel-vault/api/internal/ledger/contracts/v1"
	"strconv"
)

const DefaultBuybackTreasury = "inventory-buyback"

type Settlement struct {
	Client   v1.Client
	Treasury string
}

func (s Settlement) Execute(ctx context.Context, c domain.SettlementCommand) (domain.SettlementFact, error) {
	if s.Client == nil {
		return domain.SettlementFact{}, errors.New("wallet client is required")
	}
	request := v1.Command{ID: c.ID, IntentID: c.IntentID}
	switch c.Step {
	case domain.ReserveCost:
		request.Action = "reserve"
	case domain.CaptureCost:
		request.Action = "capture"
	case domain.CancelCost:
		request.Action = "cancel"
	case domain.AwardValue:
		request.Action = "credit"
	case domain.CloseAward:
		request.Action = "close"
	case domain.FundSale:
		request.Action = "payout"
		if !domain.ValidID(s.Treasury) {
			return domain.SettlementFact{}, &inventory.PermanentFailure{Code: "treasury_not_configured"}
		}
	case domain.CloseSale:
		request.Action = "close_payout"
	default:
		return domain.SettlementFact{}, &inventory.PermanentFailure{Code: "invalid_step"}
	}
	if c.Step == domain.ReserveCost || c.Step == domain.AwardValue || c.Step == domain.FundSale {
		purpose := "spending"
		if c.Step == domain.AwardValue {
			purpose = "reward"
		}
		if c.Step == domain.FundSale {
			purpose = "buyback"
		}
		request.Terms = &v1.Terms{Subject: c.Owner, Asset: c.Quote.Asset, Units: strconv.FormatInt(c.Quote.Units, 10), Purpose: purpose, Evidence: c.Evidence}
		if c.Step == domain.FundSale {
			request.Terms.Treasury = s.Treasury
		}
	}
	receipt, err := s.Client.Execute(ctx, request)
	if err != nil {
		var failure *v1.Error
		if errors.As(err, &failure) && (failure.Code == v1.Invalid || failure.Code == v1.Conflict || failure.Code == v1.Forbidden) {
			return domain.SettlementFact{}, &inventory.PermanentFailure{Code: failure.Code}
		}
		return domain.SettlementFact{}, err
	}
	if receipt.IntentID != c.IntentID {
		return domain.SettlementFact{}, &inventory.PermanentFailure{Code: "wrong_intent"}
	}
	funded := c.Step == domain.FundSale || c.Step == domain.CloseSale
	if funded && receipt.Kind != "payout" || !funded && receipt.Kind == "payout" {
		return domain.SettlementFact{}, &inventory.PermanentFailure{Code: "wrong_kind"}
	}
	if funded && receipt.Terms != nil && receipt.Terms.Treasury != s.Treasury {
		return domain.SettlementFact{}, &inventory.PermanentFailure{Code: "treasury_mismatch"}
	}
	translated, err := fact(receipt)
	if err != nil {
		return translated, err
	}
	debit := c.Step == domain.ReserveCost || c.Step == domain.CaptureCost || c.Step == domain.CancelCost
	debitOutcome := translated.Outcome == domain.FundsHeld || translated.Outcome == domain.FundsDeclined || translated.Outcome == domain.DebitRecorded || translated.Outcome == domain.DebitCanceled
	if debit != debitOutcome {
		return translated, &inventory.PermanentFailure{Code: "wrong_kind"}
	}
	if t := translated.Terms; t != nil {
		purpose := "spending"
		if c.Step == domain.AwardValue || c.Step == domain.CloseAward {
			purpose = "reward"
		}
		if funded {
			purpose = "buyback"
		}
		if *t != (domain.SettlementTerms{Owner: c.Owner, Asset: c.Quote.Asset, Units: c.Quote.Units, Purpose: purpose, Evidence: c.Evidence}) {
			return translated, &inventory.PermanentFailure{Code: "terms_mismatch"}
		}
	}
	return translated, nil
}
func fact(r v1.Receipt) (domain.SettlementFact, error) {
	result := domain.SettlementFact{IntentID: r.IntentID, Version: r.Version, Reason: r.Reason}
	switch r.Kind {
	case "", "debit", "award", "payout":
	default:
		return result, &inventory.PermanentFailure{Code: "unknown_wallet_kind"}
	}
	if r.Kind == "debit" && r.State != "reserved" && r.State != "declined" && r.State != "captured" && r.State != "canceled" {
		return result, &inventory.PermanentFailure{Code: "invalid_debit_state"}
	}
	if r.Kind == "award" && r.State != "credited" && r.State != "rejected" && r.State != "closed" {
		return result, &inventory.PermanentFailure{Code: "invalid_award_state"}
	}
	if r.Kind == "payout" {
		if r.State != "credited" && r.State != "rejected" && r.State != "closed" {
			return result, &inventory.PermanentFailure{Code: "invalid_payout_state"}
		}
		if r.Terms != nil && (r.Terms.Purpose != "buyback" || !domain.ValidID(r.Terms.Treasury)) {
			return result, &inventory.PermanentFailure{Code: "invalid_payout_terms"}
		}
	} else if r.Terms != nil && (r.Terms.Purpose == "buyback" || r.Terms.Treasury != "") {
		return result, &inventory.PermanentFailure{Code: "wrong_kind"}
	}
	switch r.State {
	case "reserved":
		result.Outcome = domain.FundsHeld
	case "declined":
		result.Outcome = domain.FundsDeclined
	case "captured":
		result.Outcome = domain.DebitRecorded
	case "canceled":
		result.Outcome = domain.DebitCanceled
	case "credited":
		result.Outcome = domain.AwardRecorded
	case "rejected":
		result.Outcome = domain.AwardRejected
	case "closed":
		result.Outcome = domain.AwardClosed
	default:
		return result, &inventory.PermanentFailure{Code: "unknown_wallet_state"}
	}
	if !domain.ValidID(r.IntentID) || r.Version == 0 {
		return result, &inventory.PermanentFailure{Code: "invalid_receipt"}
	}
	if (r.State == "captured" || r.State == "credited") && !domain.ValidID(r.JournalID) {
		return result, &inventory.PermanentFailure{Code: "missing_journal"}
	}
	if r.Terms == nil && r.State != "canceled" && r.State != "closed" {
		return result, &inventory.PermanentFailure{Code: "missing_terms"}
	}
	if t := r.Terms; t != nil {
		units, err := strconv.ParseInt(t.Units, 10, 64)
		if err != nil || units <= 0 || strconv.FormatInt(units, 10) != t.Units {
			return result, &inventory.PermanentFailure{Code: "invalid_units"}
		}
		result.Terms = &domain.SettlementTerms{Owner: t.Subject, Asset: t.Asset, Units: units, Purpose: t.Purpose, Evidence: t.Evidence}
	}
	return result, nil
}

// Receiver is bound to an authenticated Wallet event source by the composition/transport
// adapter. Producer is a routing key, never proof that the event came from Wallet.
type Receiver struct {
	Service   *inventory.Service
	Producer  string
	Treasury  string
	Principal inventory.Principal
}

func (r Receiver) Deliver(ctx context.Context, event v1.Event) error {
	if r.Service == nil || !domain.ValidID(r.Producer) {
		return domain.ErrInvalid
	}
	if r.Principal.Kind != "service" || !domain.ValidID(r.Principal.ID) {
		return inventory.ErrForbidden
	}
	if event.Producer != r.Producer {
		return domain.ErrInvalid
	} // Mismatched routing is not an acknowledgment.
	if event.Receipt.Kind == "payout" && event.Receipt.Terms != nil && event.Receipt.Terms.Treasury != r.Treasury {
		return domain.ErrInvalid
	}
	if event.Version != 1 || !domain.ValidID(event.ID) || event.CorrelationID != event.Receipt.IntentID || (event.CausationID != "" && !domain.ValidID(event.CausationID)) {
		return domain.ErrInvalid
	}
	f, err := fact(event.Receipt)
	if err != nil {
		return err
	}
	ctx = inventory.WithAuthenticatedPrincipal(ctx, r.Principal)
	ctx = inventory.WithOperationScope(ctx, f.IntentID)
	return r.Service.Observe(ctx, domain.Identity("wallet-event", event.ID), f)
}
