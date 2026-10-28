package postgres_test

import (
	"crypto/ed25519"
	"errors"
	"testing"
	"time"

	"github.com/voxel-vault/api/ledger/adapters/postgres"
	"github.com/voxel-vault/api/ledger/application"
	"github.com/voxel-vault/api/ledger/domain"
)

func TestAdminAllocationNeedsThreeDistinctPartiesAndIsAudited(t *testing.T) {
	db, store := database(t)
	for _, name := range []string{"treasury", "inventory-buyback"} {
		if err := store.OpenAccount(ctx, domain.TreasuryAccount(name, "coins")); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO ledger.intents(producer,id) VALUES('t','seed')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO ledger.accounts(id,subject,asset,role) VALUES('x','equity','coins','opening_equity')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO ledger.journals(id,producer,intent_id,asset,occurred_at) VALUES('seed','t','seed','coins',now())`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO ledger.postings(journal_id,ordinal,account_id,asset,side,units) VALUES('seed',0,$1,'coins','credit',100),('seed',1,'x','coins','debit',100)`, domain.TreasuryAccount("treasury", "coins").ID); err != nil {
		t.Fatal(err)
	}
	keys := map[string]ed25519.PrivateKey{}
	for key, party := range map[string]string{"a1": "alice", "a2": "alice", "b": "bob", "c": "carol"} {
		pub, priv, err := ed25519.GenerateKey(nil)
		if err != nil {
			t.Fatal(err)
		}
		keys[key] = priv
		if _, err = db.Exec(`INSERT INTO ledger.admin_keys(key_id,party,public_key) VALUES($1,$2,$3)`, key, party, []byte(pub)); err != nil {
			t.Fatal(err)
		}
	}
	const action, payload = "allocate", `{"From":"treasury","To":"inventory-buyback","Asset":"coins","Units":40,"Nonce":"1"}`
	sign := func(key string) []byte { return ed25519.Sign(keys[key], postgres.AdminMessage(action, payload)) }
	id, err := store.AdminCreate(ctx, "a1", action, payload, sign("a1"))
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 28, 17, 0, 0, 0, time.UTC)
	if err = store.AdminExecute(ctx, id, at); !errors.Is(err, application.ErrForbidden) {
		t.Fatalf("no signatures: %v", err)
	}
	// Two keys of one party are one party; a signature by another key is rejected.
	if err = store.AdminSign(ctx, id, "a1", sign("a1")); err != nil {
		t.Fatal(err)
	}
	if err = store.AdminSign(ctx, id, "a2", sign("a2")); err != nil {
		t.Fatal(err)
	}
	if err = store.AdminSign(ctx, id, "b", sign("c")); !errors.Is(err, application.ErrForbidden) {
		t.Fatalf("wrong key: %v", err)
	}
	if err = store.AdminExecute(ctx, id, at); !errors.Is(err, application.ErrForbidden) {
		t.Fatalf("one party: %v", err)
	}
	for _, k := range []string{"b", "c"} {
		if err = store.AdminSign(ctx, id, k, sign(k)); err != nil {
			t.Fatal(err)
		}
	}
	if err = store.AdminExecute(ctx, id, at); err != nil {
		t.Fatal(err)
	}
	if err = store.AdminExecute(ctx, id, at); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("second run: %v", err)
	}
	var moved int64
	if err = db.QueryRow(`SELECT sum(CASE side WHEN 'credit' THEN units ELSE -units END) FROM ledger.postings WHERE account_id=$1`, domain.TreasuryAccount("inventory-buyback", "coins").ID).Scan(&moved); err != nil || moved != 40 {
		t.Fatalf("buyback holds %d: %v", moved, err)
	}
	if err = store.VerifyAdminAudit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`UPDATE ledger.admin_audit SET event='forged' WHERE seq=2`); err != nil {
		t.Fatal(err)
	}
	if err = store.VerifyAdminAudit(ctx); err == nil {
		t.Fatal("a rewritten audit row must break the chain")
	}
	// More than the treasury holds is refused even with three signatures.
	over := `{"From":"treasury","To":"inventory-buyback","Asset":"coins","Units":61,"Nonce":"2"}`
	oid, err := store.AdminCreate(ctx, "b", action, over, ed25519.Sign(keys["b"], postgres.AdminMessage(action, over)))
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"a1", "b", "c"} {
		if err = store.AdminSign(ctx, oid, k, ed25519.Sign(keys[k], postgres.AdminMessage(action, over))); err != nil {
			t.Fatal(err)
		}
	}
	if err = store.AdminExecute(ctx, oid, at); !errors.Is(err, application.ErrTransferFunds) {
		t.Fatalf("overdraw: %v", err)
	}
}
