package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"time"

	"github.com/voxel-vault/api/ledger/application"
	"github.com/voxel-vault/api/ledger/domain"
)

func (s *Store) OpenTreasury(ctx context.Context, producer string, input application.TreasuryOpening, at time.Time) (application.Receipt, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return application.Receipt{}, err
	}
	defer tx.Rollback()
	body, err := json.Marshal(input)
	if err != nil {
		return application.Receipt{}, err
	}
	fingerprint := domain.Identity(producer, string(body))
	if _, err = tx.ExecContext(ctx, `INSERT INTO ledger.treasury_openings(treasury,asset,fingerprint,request) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, input.Treasury, input.Asset, fingerprint, body); err != nil {
		return application.Receipt{}, err
	}
	var prior string
	var saved []byte
	if err = tx.QueryRowContext(ctx, `SELECT fingerprint,receipt FROM ledger.treasury_openings WHERE treasury=$1 AND asset=$2 FOR UPDATE`, input.Treasury, input.Asset).Scan(&prior, &saved); err != nil {
		return application.Receipt{}, err
	}
	if prior != fingerprint {
		return application.Receipt{}, domain.ErrConflict
	}
	if saved != nil {
		var receipt application.Receipt
		if err = json.Unmarshal(saved, &receipt); err != nil {
			return receipt, err
		}
		return receipt, tx.Commit()
	}
	u := unit{ctx: ctx, tx: tx}
	id := domain.Identity("treasury-opening", input.Treasury, input.Asset)
	intent, err := u.LockIntent(producer, id)
	if err != nil {
		return application.Receipt{}, err
	}
	if intent.Terms != nil || intent.State != domain.Missing {
		return application.Receipt{}, domain.ErrConflict
	}
	terms := domain.Terms{Subject: "system", Asset: input.Asset, Units: input.Units, Treasury: input.Treasury, Purpose: domain.TreasuryOpening, Evidence: domain.Identity("treasury-funding", input.Source, input.Reference)}
	treasury := domain.TreasuryAccount(input.Treasury, input.Asset)
	equity := domain.CounterAccount(domain.Terms{Asset: input.Asset, Purpose: domain.OpeningBalance}, domain.Credit)
	if err = u.LockAccounts([]domain.Account{treasury, equity}); err != nil {
		return application.Receipt{}, err
	}
	funds, err := u.Funds(treasury.ID)
	if err != nil {
		return application.Receipt{}, err
	}
	if _, err = funds.Available(); err != nil {
		return application.Receipt{}, err
	}
	if input.Units > math.MaxInt64-funds.Posted {
		return application.Receipt{}, domain.ErrInvariant
	}
	intent.Kind = domain.Award
	intent.State = domain.Credited
	intent.Terms = &terms
	intent.Version = 1
	if err = u.SaveIntent(intent); err != nil {
		return application.Receipt{}, err
	}
	journal := domain.Journal{ID: domain.Identity("journal", producer, id), Producer: producer, IntentID: id, Asset: input.Asset, At: at, Postings: []domain.Posting{{Account: equity.ID, Asset: input.Asset, Side: domain.Dr, Units: input.Units}, {Account: treasury.ID, Asset: input.Asset, Side: domain.Cr, Units: input.Units}}}
	if err = u.AppendJournal(journal); err != nil {
		return application.Receipt{}, err
	}
	receipt := application.Receipt{Intent: intent, JournalID: journal.ID}
	saved, err = json.Marshal(receipt)
	if err != nil {
		return receipt, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE ledger.treasury_openings SET receipt=$3 WHERE treasury=$1 AND asset=$2`, input.Treasury, input.Asset, saved); err != nil {
		return receipt, err
	}
	return receipt, tx.Commit()
}

var _ application.TreasuryOpeningStore = (*Store)(nil)
