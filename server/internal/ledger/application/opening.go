package application

import (
	"context"
	"encoding/hex"
	"math"
	"time"

	"github.com/voxel-vault/api/internal/ledger/domain"
)

// Opening imports a complete offline baseline into an empty Wallet. It is deliberately
// separate from ordinary settlement authority and does not read a legacy database.
type OpeningBalance struct {
	Subject, Asset string
	Units          int64
}
type Opening struct {
	Source, Digest string
	At             time.Time
	Balances       []OpeningBalance
}
type OpeningRecord struct {
	Balance OpeningBalance
	Receipt Receipt
	Journal domain.Journal
	Event   Event
}
type OpeningStore interface {
	ImportOpening(context.Context, Opening, []OpeningRecord) error
}
type OpeningService struct {
	Store      OpeningStore
	Authorizer Authorizer
	Producer   string
}

func (s OpeningService) Import(ctx context.Context, input Opening) error {
	decoded, err := hex.DecodeString(input.Digest)
	if s.Store == nil || s.Authorizer == nil || !domain.ValidID(s.Producer) || !domain.ValidID(input.Source) || err != nil || len(decoded) != 32 || hex.EncodeToString(decoded) != input.Digest || input.At.IsZero() {
		return domain.ErrInvalid
	}
	input.Balances = append([]OpeningBalance(nil), input.Balances...)
	if err := s.Authorizer.Authorize(ctx, s.Producer, domain.Credit, nil); err != nil {
		return err
	}
	seen := map[string]bool{}
	totals := map[string]int64{}
	for _, b := range input.Balances {
		if !domain.ValidID(b.Subject) || !domain.ValidID(b.Asset) || b.Units < 0 {
			return domain.ErrInvalid
		}
		key := domain.Identity(b.Subject, b.Asset)
		if seen[key] {
			return domain.ErrConflict
		}
		seen[key] = true
		if totals[b.Asset] > math.MaxInt64-b.Units {
			return domain.ErrInvalid
		}
		totals[b.Asset] += b.Units
	}
	if err := authorizeIssuance(ctx, s.Authorizer, s.Producer, Issuance{Purpose: domain.OpeningBalance, Source: input.Source, Reference: input.Digest, Totals: totals}); err != nil {
		return err
	}
	var records []OpeningRecord
	for _, b := range input.Balances {
		terms := domain.Terms{Subject: b.Subject, Asset: b.Asset, Units: b.Units, Purpose: domain.OpeningBalance, Evidence: input.Digest}
		if err := s.Authorizer.Authorize(ctx, s.Producer, domain.Credit, &terms); err != nil {
			return err
		}
		if b.Units == 0 {
			continue
		} // Zero balances need an audit row, not an invalid zero posting.
		id := domain.Identity("opening", input.Source, b.Subject, b.Asset)
		intent := domain.Intent{Producer: s.Producer, ID: id, State: domain.Missing}
		next, _, err := intent.Apply(domain.Credit, &terms, domain.Funds{})
		if err != nil {
			return err
		}
		journal, err := domain.SettlementJournal(next, domain.Credit, input.At.UTC())
		if err != nil {
			return err
		}
		receipt := Receipt{Intent: next, JournalID: journal.ID}
		commandID := domain.Identity("opening-command", input.Source, b.Subject, b.Asset)
		event := Event{ID: domain.Identity("event", s.Producer, id, string(next.State)), CausationID: commandID, Receipt: receipt, At: input.At.UTC()}
		records = append(records, OpeningRecord{b, receipt, journal, event})
	}
	return s.Store.ImportOpening(ctx, input, records)
}
