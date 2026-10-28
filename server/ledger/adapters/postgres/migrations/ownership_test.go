package migrations

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestOwnershipUpgradePreservesEveryHistoricalRow(t *testing.T) {
	dsn := os.Getenv("TEST_WALLET_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_WALLET_DATABASE_URL is required for a disposable migration database")
	}
	ctx := context.Background()
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Close() })
	name := fmt.Sprintf("ownership_%d_%d", os.Getpid(), time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Path = "/" + name
	db, err := sql.Open("pgx", parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Close()
		if _, err := admin.ExecContext(ctx, "DROP DATABASE "+name+" WITH (FORCE)"); err != nil {
			t.Error(err)
		}
	})
	provider, err := Provider(db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, 6); err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(ctx, `
INSERT INTO wallet.accounts(id,subject,asset,role) VALUES('user-account','alice','currency','player_liability'),('source-account','system','currency','opening_equity');
INSERT INTO wallet.intents(producer,id,body) VALUES('inventory','pending','{"Producer":"inventory","ID":"pending","State":"reserved","Version":1}'),('inventory','posted','{"Producer":"inventory","ID":"posted","State":"credited","Version":1}');
INSERT INTO wallet.commands(producer,id,fingerprint,receipt) VALUES('inventory','old-key','unchanged-fingerprint','{"Intent":{"ID":"pending","State":"reserved"}}');
INSERT INTO wallet.holds(producer,intent_id,account_id,units) VALUES('inventory','pending','user-account',40);
INSERT INTO wallet.journals(id,producer,intent_id,asset,occurred_at) VALUES('journal','inventory','posted','currency','2026-10-27T00:00:00Z');
INSERT INTO wallet.postings(journal_id,ordinal,account_id,asset,side,units) VALUES('journal',0,'source-account','currency','debit',100),('journal',1,'user-account','currency','credit',100);
INSERT INTO wallet.outbox(id,payload,created_at,available_at,producer) VALUES('event','{"old":"immutable"}','2026-10-27T00:00:00Z','2026-10-27T00:00:00Z','inventory');
INSERT INTO wallet.opening_baseline(singleton,source,digest,payload) VALUES(true,'source','digest','{"snapshot":"immutable"}');
INSERT INTO wallet.treasury_openings(treasury,asset,fingerprint,request,receipt) VALUES('tax','currency','funding-fingerprint','{"Units":100}','{"JournalID":"funding"}');
`)
	if err != nil {
		t.Fatal(err)
	}
	tables := []string{"accounts", "intents", "commands", "holds", "journals", "postings", "outbox", "opening_baseline", "treasury_openings"}
	snapshot := func(schema string) map[string]string {
		t.Helper()
		result := map[string]string{}
		for _, table := range tables {
			var value string
			query := "SELECT jsonb_agg(value ORDER BY value::text)::text FROM (SELECT to_jsonb(t)-'active'-'status'-'kind' AS value FROM " + schema + "." + table + " t) s"
			if err := db.QueryRowContext(ctx, query).Scan(&value); err != nil {
				t.Fatal(err)
			}
			result[table] = value
		}
		return result
	}
	before := snapshot("wallet")
	if _, err := provider.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if err := Up(ctx, db); err != nil {
		t.Fatal("repeat migration", err)
	}
	after := snapshot("ledger")
	for _, table := range tables {
		if before[table] != after[table] {
			t.Fatalf("%s changed: before %s, after %s", table, before[table], after[table])
		}
	}
	var version int
	if err := db.QueryRowContext(ctx, `SELECT max(version_id) FROM wallet_schema_version`).Scan(&version); err != nil || version != 10 {
		t.Fatal(version, err)
	}
	var posted, held int64
	if err := db.QueryRowContext(ctx, `SELECT sum(CASE side WHEN 'credit' THEN units ELSE -units END) FROM ledger.postings WHERE account_id='user-account'`).Scan(&posted); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT sum(units) FROM ledger.holds WHERE account_id='user-account'`).Scan(&held); err != nil || posted != 100 || held != 40 {
		t.Fatal(posted, held, err)
	}
}
