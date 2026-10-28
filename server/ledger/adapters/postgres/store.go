// Package postgres persists Wallet state exclusively in the wallet schema. Its unit of
// work is never joined to an Inventory/Accounts transaction or foreign repository.
package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/voxel-vault/api/ledger/application"
	"github.com/voxel-vault/api/ledger/domain"
)

type Store struct {
	db *sql.DB
	// quotesPerSecond and quotesPerDay come from TRANSFER_CONFIG; zero refuses every quote.
	quotesPerSecond, quotesPerDay int
	// transfersPerMinute and suspendMinutes drive the automatic send block; zero refuses transfers.
	transfersPerMinute, suspendMinutes int
}

func New(db *sql.DB) *Store { return &Store{db: db} }

// LimitQuotes sets the per-subject quote caps; both must be positive.
func (s *Store) LimitQuotes(perSecond, perDay int) *Store {
	s.quotesPerSecond, s.quotesPerDay = perSecond, perDay
	return s
}

// ReadIntent is a primary-store observation, not a cancellation fence. In particular,
// Missing does not rule out a delayed command and must not authorize compensation.
func (s *Store) ReadIntent(ctx context.Context, producer, id string) (domain.Intent, error) {
	var raw []byte
	err := s.db.QueryRowContext(ctx, `SELECT body FROM ledger.intents WHERE producer=$1 AND id=$2`, producer, id).Scan(&raw)
	if err == sql.ErrNoRows {
		return domain.Intent{Producer: producer, ID: id, State: domain.Missing}, nil
	}
	if err != nil {
		return domain.Intent{}, err
	}
	var intent domain.Intent
	if err := json.Unmarshal(raw, &intent); err != nil {
		return domain.Intent{}, err
	}
	if intent.Producer != producer || intent.ID != id {
		return domain.Intent{}, domain.ErrInvariant
	}
	return intent, nil
}

func (s *Store) Transact(ctx context.Context, fn func(application.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = fn(&unit{ctx, tx, s}); err != nil {
		return err
	}
	return tx.Commit()
}

type unit struct {
	ctx context.Context
	tx  *sql.Tx
	s   *Store
}

func (t *unit) ClaimCommand(producer, id, fingerprint string) (*application.Receipt, error) {
	if _, err := t.tx.ExecContext(t.ctx, `INSERT INTO ledger.commands(producer,id,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, producer, id, fingerprint); err != nil {
		return nil, err
	}
	var existing string
	var raw []byte
	if err := t.tx.QueryRowContext(t.ctx, `SELECT fingerprint,receipt FROM ledger.commands WHERE producer=$1 AND id=$2 FOR UPDATE`, producer, id).Scan(&existing, &raw); err != nil {
		return nil, err
	}
	if existing != fingerprint {
		return nil, domain.ErrConflict
	}
	if raw == nil {
		return nil, nil
	}
	var receipt application.Receipt
	if err := json.Unmarshal(raw, &receipt); err != nil {
		return nil, err
	}
	return &receipt, nil
}
func (t *unit) LockIntent(producer, id string) (domain.Intent, error) {
	if _, err := t.tx.ExecContext(t.ctx, `INSERT INTO ledger.intents(producer,id) VALUES($1,$2) ON CONFLICT DO NOTHING`, producer, id); err != nil {
		return domain.Intent{}, err
	}
	var raw []byte
	if err := t.tx.QueryRowContext(t.ctx, `SELECT body FROM ledger.intents WHERE producer=$1 AND id=$2 FOR UPDATE`, producer, id).Scan(&raw); err != nil {
		return domain.Intent{}, err
	}
	if raw == nil {
		return domain.Intent{Producer: producer, ID: id, State: domain.Missing}, nil
	}
	var intent domain.Intent
	if err := json.Unmarshal(raw, &intent); err != nil {
		return intent, err
	}
	if intent.Producer != producer || intent.ID != id {
		return intent, domain.ErrInvariant
	}
	return intent, nil
}
func (t *unit) LockAccounts(input []domain.Account) error {
	return t.lockAccounts(input, true)
}

// Cancellation must remain able to release an existing hold on an inactive account.
func (t *unit) LockAccountsForRelease(input []domain.Account) error {
	return t.lockAccounts(input, false)
}

func (t *unit) lockAccounts(input []domain.Account, requireActive bool) error {
	accounts := append([]domain.Account(nil), input...)
	sort.Slice(accounts, func(i, j int) bool { return accounts[i].ID < accounts[j].ID })
	for _, a := range accounts {
		if a.Role != "treasury_liability" {
			if _, err := t.tx.ExecContext(t.ctx, `INSERT INTO ledger.accounts(id,subject,asset,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, a.ID, a.Subject, a.Asset, a.Role); err != nil {
				return err
			}
		}
		var subject, asset, role string
		var active bool
		if err := t.tx.QueryRowContext(t.ctx, `SELECT subject,asset,role,active FROM ledger.accounts WHERE id=$1 FOR UPDATE`, a.ID).Scan(&subject, &asset, &role, &active); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return domain.ErrAccountNotOpen
			}
			return err
		}
		if subject != a.Subject || asset != a.Asset || role != a.Role {
			return domain.ErrConflict
		}
		if requireActive && !active {
			return application.ErrForbidden
		}
	}
	return nil
}

const fundsQuery = `SELECT
 COALESCE((SELECT sum(CASE side WHEN 'credit' THEN units::numeric ELSE -units::numeric END) FROM ledger.postings WHERE account_id=$1),0),
 COALESCE((SELECT sum(units::numeric) FROM ledger.holds WHERE account_id=$1 AND status='held'),0)`

func (t *unit) Funds(account string) (domain.Funds, error) {
	var f domain.Funds
	err := t.tx.QueryRowContext(t.ctx, fundsQuery, account).Scan(&f.Posted, &f.Held)
	return f, err
}
func (t *unit) SaveIntent(i domain.Intent) error {
	raw, err := json.Marshal(i)
	if err != nil {
		return err
	}
	if _, err = t.tx.ExecContext(t.ctx, `UPDATE ledger.intents SET body=$3 WHERE producer=$1 AND id=$2`, i.Producer, i.ID, raw); err != nil {
		return err
	}
	if i.State == domain.Reserved {
		if i.Terms == nil {
			return domain.ErrInvariant
		}
		a := domain.PlayerAccount(*i.Terms)
		_, err = t.tx.ExecContext(t.ctx, `INSERT INTO ledger.holds(producer,intent_id,account_id,units) VALUES($1,$2,$3,$4)`, i.Producer, i.ID, a.ID, i.Terms.Units)
	} else {
		_, err = t.tx.ExecContext(t.ctx, `UPDATE ledger.holds SET status=CASE WHEN $3 THEN 'captured' ELSE 'released' END WHERE producer=$1 AND intent_id=$2 AND status='held'`, i.Producer, i.ID, i.State == domain.Captured)
	}
	return err
}
func (t *unit) AppendJournal(j domain.Journal) error {
	if err := j.Validate(); err != nil {
		return err
	}
	if _, err := t.tx.ExecContext(t.ctx, `INSERT INTO ledger.journals(id,producer,intent_id,asset,occurred_at) VALUES($1,$2,$3,$4,$5)`, j.ID, j.Producer, j.IntentID, j.Asset, j.At); err != nil {
		return err
	}
	for n, p := range j.Postings {
		if _, err := t.tx.ExecContext(t.ctx, `INSERT INTO ledger.postings(journal_id,ordinal,account_id,asset,side,units) VALUES($1,$2,$3,$4,$5,$6)`, j.ID, n, p.Account, p.Asset, p.Side, p.Units); err != nil {
			return err
		}
	}
	return nil
}
func (t *unit) CompleteCommand(producer, id string, r application.Receipt) error {
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	result, err := t.tx.ExecContext(t.ctx, `UPDATE ledger.commands SET receipt=$3 WHERE producer=$1 AND id=$2 AND receipt IS NULL`, producer, id, raw)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return fmt.Errorf("%w: command receipt not claimed", domain.ErrInvariant)
	}
	return nil
}
func (t *unit) Enqueue(e application.Event) error {
	raw, err := json.Marshal(e)
	if err != nil {
		return err
	}
	_, err = t.tx.ExecContext(t.ctx, `INSERT INTO ledger.outbox(id,payload,created_at,available_at,producer) VALUES($1,$2,$3,$3,$4)`, e.ID, raw, e.At, e.Receipt.Intent.Producer)
	return err
}

// Balance is an adapter-level read for an already-authorized query. Authorization belongs
// to the inbound/application boundary, not this repository. One statement gives one snapshot.
func (s *Store) Balance(ctx context.Context, subject, asset string) (domain.Funds, error) {
	account := domain.PlayerAccount(domain.Terms{Subject: subject, Asset: asset})
	var f domain.Funds
	err := s.db.QueryRowContext(ctx, fundsQuery, account.ID).Scan(&f.Posted, &f.Held)
	return f, err
}

// PendingEvents returns committed outbox facts. Delivery leasing/acknowledgment is a separate
// adapter slice; reading a pending event does not mark it delivered.
func (s *Store) PendingEvents(ctx context.Context) ([]application.Event, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT payload FROM ledger.outbox WHERE delivered_at IS NULL AND kind='ledger.journal.posted' ORDER BY created_at,id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []application.Event
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var e application.Event
		if err := json.Unmarshal(raw, &e); err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, rows.Err()
}

// LimitTransfers sets the confirmed-transfer burst cap and the auto-block length; both must be positive.
func (s *Store) LimitTransfers(perMinute, suspendMinutes int) *Store {
	s.transfersPerMinute, s.suspendMinutes = perMinute, suspendMinutes
	return s
}
