package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/voxel-vault/api/internal/ledger/application"
	"github.com/voxel-vault/api/internal/ledger/domain"
)

// ImportOpening commits the entire Wallet baseline locally. Table locks exclude ordinary
// writers during validation/import; the migration command must still run before cutover.
func (s *Store) ImportOpening(ctx context.Context, input application.Opening, records []application.OpeningRecord) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `LOCK TABLE ledger.commands,ledger.intents,ledger.accounts,ledger.holds,ledger.journals,ledger.postings,ledger.outbox,ledger.opening_baseline IN EXCLUSIVE MODE`); err != nil {
		return err
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return err
	}
	var same bool
	err = tx.QueryRowContext(ctx, `SELECT source=$1 AND digest=$2 AND payload=$3::jsonb FROM ledger.opening_baseline`, input.Source, input.Digest, raw).Scan(&same)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	t := &unit{ctx: ctx, tx: tx}
	if err == sql.ErrNoRows {
		for _, table := range []string{"commands", "intents", "accounts", "holds", "journals", "postings", "outbox"} {
			var exists bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ledger.`+table+`)`).Scan(&exists); err != nil {
				return err
			}
			if exists {
				return fmt.Errorf("wallet baseline requires an empty target: %w", domain.ErrConflict)
			}
		}
		for _, r := range records {
			terms := *r.Receipt.Intent.Terms
			command := application.Command{Producer: r.Receipt.Intent.Producer, ID: r.Event.CausationID, IntentID: r.Receipt.Intent.ID, Action: domain.Credit, Terms: &terms}
			body, err := json.Marshal(command)
			if err != nil {
				return err
			}
			if _, err = t.ClaimCommand(command.Producer, command.ID, domain.Identity(string(body))); err != nil {
				return err
			}
			if _, err = t.LockIntent(command.Producer, command.IntentID); err != nil {
				return err
			}
			if err = t.LockAccounts([]domain.Account{domain.PlayerAccount(terms), domain.CounterAccount(terms, domain.Credit)}); err != nil {
				return err
			}
			if err = t.SaveIntent(r.Receipt.Intent); err != nil {
				return err
			}
			if err = t.AppendJournal(r.Journal); err != nil {
				return err
			}
			if err = t.CompleteCommand(command.Producer, command.ID, r.Receipt); err != nil {
				return err
			}
			if err = t.Enqueue(r.Event); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO ledger.opening_baseline(singleton,source,digest,payload) VALUES(true,$1,$2,$3)`, input.Source, input.Digest, raw); err != nil {
			return err
		}
	} else if !same {
		return domain.ErrConflict
	}
	// A replay proves the target is still the imported baseline, not just that receipts exist.
	for _, table := range []string{"commands", "intents", "journals", "outbox"} {
		var n int
		if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM ledger.`+table).Scan(&n); err != nil {
			return err
		}
		if n != len(records) {
			return domain.ErrConflict
		}
	}
	var holds int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM ledger.holds WHERE status='held'`).Scan(&holds); err != nil {
		return err
	}
	if holds != 0 {
		return domain.ErrConflict
	}
	expectedAccounts := map[string]bool{}
	for _, r := range records {
		terms := *r.Receipt.Intent.Terms
		expectedAccounts[domain.PlayerAccount(terms).ID] = true
		expectedAccounts[domain.CounterAccount(terms, domain.Credit).ID] = true
	}
	var accounts, postings int
	if err = tx.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM ledger.accounts),(SELECT count(*) FROM ledger.postings)`).Scan(&accounts, &postings); err != nil {
		return err
	}
	if accounts != len(expectedAccounts) || postings != 2*len(records) {
		return domain.ErrConflict
	}
	for _, b := range input.Balances {
		funds, err := t.Funds(domain.PlayerAccount(domain.Terms{Subject: b.Subject, Asset: b.Asset}).ID)
		if err != nil {
			return err
		}
		if funds.Posted != b.Units || funds.Held != 0 {
			return domain.ErrInvariant
		}
	}
	return tx.Commit()
}
