package postgres

import (
	"context"
	"database/sql"
	"time"

	"github.com/voxel-vault/api/ledger/application"
	"github.com/voxel-vault/api/ledger/domain"
)

const sweepProducer = "tax-sweeper"

// SweepTreasury moves everything available on one open treasury account to another, at most
// once per window (intent sweep:<asset>:<window>). It returns the moved units; 0 means the
// window was already swept or there was nothing to move. Both accounts must already be open.
// shortcut: the "only platform-tax -> treasury" limit is the caller's fixed arguments plus the
// runtime DB role; there is no per-service authorizer yet.
func (s *Store) SweepTreasury(ctx context.Context, from, to, asset string, window, at time.Time) (int64, error) {
	if from == to || !domain.ValidID(from) || !domain.ValidID(to) || !domain.ValidID(asset) || window.IsZero() || at.IsZero() {
		return 0, domain.ErrInvalid
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	u := unit{ctx: ctx, tx: tx}
	id := domain.Identity("tax-sweep", from, to, asset, window.UTC().Format(time.RFC3339))
	units, err := moveFunds(&u, sweepProducer, id, domain.TaxSweep, from, to, asset, 0, at)
	if err != nil {
		return 0, err
	}
	return units, tx.Commit()
}

// moveFunds moves units (0 = everything available) between two open treasury accounts under a
// fresh intent. It returns 0 when the intent already exists or there is nothing to move;
// asking for more than is available is ErrTransferFunds.
func moveFunds(u *unit, producer, id string, purpose domain.Purpose, from, to, asset string, units int64, at time.Time) (int64, error) {
	intent, err := u.LockIntent(producer, id)
	if err != nil {
		return 0, err
	}
	if intent.State != domain.Missing {
		return 0, nil
	}
	src, dst := domain.TreasuryAccount(from, asset), domain.TreasuryAccount(to, asset)
	if err = u.LockAccounts([]domain.Account{src, dst}); err != nil {
		return 0, err
	}
	funds, err := u.Funds(src.ID)
	if err != nil {
		return 0, err
	}
	available, err := funds.Available()
	if err != nil {
		return 0, err
	}
	if units == 0 {
		units = available
	} else if units > available {
		return 0, application.ErrTransferFunds
	}
	if units <= 0 {
		return 0, nil
	}
	terms := domain.Terms{Subject: "system", Asset: asset, Units: units, Treasury: to, Purpose: purpose, Evidence: id}
	intent.Kind, intent.State, intent.Terms, intent.Version = domain.Award, domain.Credited, &terms, 1
	if err = u.SaveIntent(intent); err != nil {
		return 0, err
	}
	journal := domain.Journal{ID: domain.Identity("journal", producer, id), Producer: producer, IntentID: id, Asset: asset, At: at, Postings: []domain.Posting{
		{Account: src.ID, Asset: asset, Side: domain.Dr, Units: units}, {Account: dst.ID, Asset: asset, Side: domain.Cr, Units: units}}}
	return units, u.AppendJournal(journal)
}
