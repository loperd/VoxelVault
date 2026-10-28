package postgres_test

import (
	"errors"
	"testing"

	"github.com/voxel-vault/api/ledger/adapters/authorization"
	"github.com/voxel-vault/api/ledger/adapters/postgres"
	"github.com/voxel-vault/api/ledger/application"
	"github.com/voxel-vault/api/ledger/domain"
)

func TestInactiveAccountBlocksNewMoneyMovementsButAllowsHoldRelease(t *testing.T) {
	db, store := database(t)
	s := service(t, store)
	execute(t, s, command("fund", "fund", domain.Credit, 100))
	execute(t, s, command("reserve", "hold", domain.Reserve, 30))
	a := domain.PlayerAccount(domain.Terms{Subject: "player", Asset: "coins"})
	if _, err := db.Exec(`UPDATE ledger.accounts SET active=false WHERE id=$1`, a.ID); err != nil {
		t.Fatal(err)
	}
	for _, c := range []application.Command{command("new-reserve", "new-hold", domain.Reserve, 1), command("new-credit", "new-credit", domain.Credit, 1), command("capture", "hold", domain.Capture, 0)} {
		if _, err := s.Execute(ctx, c); !errors.Is(err, application.ErrForbidden) {
			t.Fatal(c.Action, err)
		}
	}
	funds(t, store, 100, 30)
	execute(t, s, command("cancel", "hold", domain.Cancel, 0))
	funds(t, store, 100, 0)
	var status string
	if err := db.QueryRow(`SELECT status FROM ledger.holds WHERE intent_id='hold'`).Scan(&status); err != nil || status != "released" {
		t.Fatal(status, err)
	}
	if count(t, db, "journals") != 1 {
		t.Fatal("inactive operations posted money")
	}
}

func TestInactivePayoutAccountsAreRejectedBeforePostings(t *testing.T) {
	for _, target := range []string{"recipient", "treasury"} {
		t.Run(target, func(t *testing.T) {
			db, store := database(t)
			_, opening := treasuryServices(t, postgres.New(db))
			if _, err := opening.Open(ctx, allocation(100)); err != nil {
				t.Fatal(err)
			}
			execute(t, service(t, store), command("fund", "fund", domain.Credit, 1))
			a := domain.PlayerAccount(domain.Terms{Subject: "player", Asset: "coins"})
			if target == "treasury" {
				a = domain.TreasuryAccount("buyback", "coins")
			}
			if _, err := db.Exec(`UPDATE ledger.accounts SET active=false WHERE id=$1`, a.ID); err != nil {
				t.Fatal(err)
			}
			s, _ := treasuryServices(t, store)
			before := count(t, db, "journals")
			if _, err := s.Execute(ctx, payout("payout", "player", 5)); !errors.Is(err, application.ErrForbidden) {
				t.Fatal(err)
			}
			if count(t, db, "journals") != before {
				t.Fatal("inactive payout posted money")
			}
		})
	}
}

func TestTreasuryAccountsOpenOnlyExplicitlyAndCanonically(t *testing.T) {
	db, store := database(t)
	valid := domain.TreasuryAccount("tax", "coins")
	invalid := valid
	invalid.ID = "arbitrary-id"
	if err := store.OpenAccount(ctx, invalid); !errors.Is(err, domain.ErrInvalid) {
		t.Fatal(err)
	}
	if count(t, db, "accounts") != 0 {
		t.Fatal("invalid account persisted")
	}
	err := store.Transact(ctx, func(tx application.Tx) error { return tx.LockAccounts([]domain.Account{valid}) })
	if !errors.Is(err, domain.ErrAccountNotOpen) || count(t, db, "accounts") != 0 {
		t.Fatalf("a posting must not open a treasury account: %v", err)
	}
	for range 2 {
		if err := store.OpenAccount(ctx, valid); err != nil {
			t.Fatal(err)
		}
	}
	if count(t, db, "accounts") != 1 {
		t.Fatal("canonical account not provisioned once")
	}
}

func TestGenericSettlementCannotUseReservedTransferProducer(t *testing.T) {
	_, store := database(t)
	c := command("forged", "forged", domain.Credit, 1)
	c.Producer = "user-transfer"
	if _, err := service(t, store).Execute(ctx, c); !errors.Is(err, domain.ErrInvalid) {
		t.Fatal(err)
	}
	if _, err := authorization.New([]authorization.Grant{{Producer: "user-transfer", Actions: []domain.Action{domain.Credit}, Assets: []string{"coins"}, Subjects: []string{"player"}}}); !errors.Is(err, domain.ErrInvalid) {
		t.Fatal(err)
	}
}
