package postgres

import (
	"context"
	"database/sql"

	"github.com/voxel-vault/api/ledger/application"
	v1 "github.com/voxel-vault/api/ledger/contracts/v1"
	"github.com/voxel-vault/api/ledger/domain"
)

func (s *Store) Balances(ctx context.Context, subject string, assets []string) (map[string]domain.Funds, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	result := map[string]domain.Funds{}
	for _, asset := range assets {
		var funds domain.Funds
		id := domain.PlayerAccount(domain.Terms{Subject: subject, Asset: asset}).ID
		if err = tx.QueryRowContext(ctx, fundsQuery, id).Scan(&funds.Posted, &funds.Held); err != nil {
			return nil, err
		}
		if _, err = funds.Available(); err != nil {
			return nil, err
		}
		result[asset] = funds
	}
	return result, tx.Commit()
}
func (s *Store) History(ctx context.Context, subject, asset string, after *application.HistoryCursor, limit int) ([]application.HistoryEntry, error) {
	id := domain.PlayerAccount(domain.Terms{Subject: subject, Asset: asset}).ID
	var at any
	cursorID := ""
	if after != nil {
		at = after.At
		cursorID = after.ID
	}
	// Holds have no posting until capture. Captured holds are represented by their
	// journal only; released holds remain visible without implying a money movement.
	// Use the recorded status event for time. Missing legacy times sort last and
	// are explicitly omitted from the public DTO rather than fabricated.
	// https://www.postgresql.org/docs/15/functions-binarystring.html
	rows, err := s.db.QueryContext(ctx, `WITH history AS (
 SELECT j.id,j.asset,
 CASE WHEN sum(CASE p.side WHEN 'credit' THEN p.units::numeric ELSE -p.units::numeric END)>0 THEN 'credit' ELSE 'debit' END AS direction,
 abs(sum(CASE p.side WHEN 'credit' THEN p.units::numeric ELSE -p.units::numeric END)) AS units,
 j.occurred_at AS at,i.body#>>'{Terms,Purpose}' AS purpose,j.intent_id AS reference,
 CASE WHEN sum(CASE p.side WHEN 'credit' THEN p.units::numeric ELSE -p.units::numeric END)>0 THEN 'credited' ELSE 'captured' END AS status
 FROM ledger.postings p JOIN ledger.journals j ON j.id=p.journal_id
 JOIN ledger.intents i ON i.producer=j.producer AND i.id=j.intent_id
 WHERE p.account_id=$1
 GROUP BY j.id,i.body#>>'{Terms,Purpose}'
 HAVING sum(CASE p.side WHEN 'credit' THEN p.units::numeric ELSE -p.units::numeric END)<>0
 UNION ALL
 SELECT 'hold:' || encode(sha256(convert_to(jsonb_build_array(h.producer,h.intent_id)::text,'UTF8')),'hex'),
 a.asset,'debit',h.units,event.created_at,i.body#>>'{Terms,Purpose}',h.intent_id,h.status
 FROM ledger.holds h JOIN ledger.accounts a ON a.id=h.account_id
 JOIN ledger.intents i ON i.producer=h.producer AND i.id=h.intent_id
 LEFT JOIN LATERAL (
  SELECT o.created_at FROM ledger.outbox o WHERE o.producer=h.producer
  AND o.payload#>>'{Receipt,Intent,ID}'=h.intent_id
  AND o.payload#>>'{Receipt,Intent,State}'=i.body->>'State'
  ORDER BY o.created_at DESC,o.id DESC LIMIT 1
 ) event ON true
 WHERE h.account_id=$1 AND h.status IN ('held','released')
 ) SELECT id,asset,direction,units,coalesce(at,'0001-01-02 00:00:00+00'::timestamptz),purpose,reference,status,at IS NULL
 FROM history
 WHERE ($2::timestamptz IS NULL OR (coalesce(at,'0001-01-02 00:00:00+00'::timestamptz),id)<($2::timestamptz,$3))
 ORDER BY coalesce(at,'0001-01-02 00:00:00+00'::timestamptz) DESC,id DESC LIMIT $4`, id, at, cursorID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []application.HistoryEntry{}
	for rows.Next() {
		var e application.HistoryEntry
		if err = rows.Scan(&e.ID, &e.Asset, &e.Side, &e.Units, &e.At, &e.Purpose, &e.Reference, &e.Status, &e.TimeUnknown); err != nil {
			return nil, err
		}
		result = append(result, e)
	}
	return result, rows.Err()
}
func (s *Store) Baseline(ctx context.Context) (v1.Baseline, error) {
	var result v1.Baseline
	err := s.db.QueryRowContext(ctx, `SELECT source,digest FROM ledger.opening_baseline WHERE singleton`).Scan(&result.Source, &result.Digest)
	if err == sql.ErrNoRows {
		return result, nil
	}
	result.Complete = err == nil
	return result, err
}
