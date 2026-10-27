package postgres_test

import (
	"testing"

	"github.com/voxel-vault/api/ledger/adapters/inbound/local"
	"github.com/voxel-vault/api/ledger/application"
	"github.com/voxel-vault/api/ledger/domain"
)

func TestHistoryShowsHoldCaptureAndReleaseWithoutDoubleCounting(t *testing.T) {
	_, store := database(t)
	s := service(t, store)
	reader := application.Reader{Store: store, Authorizer: allowed, Producer: "inventory"}
	execute(t, s, command("fund", "fund", domain.Credit, 100))
	execute(t, s, command("reserve-a", "repair-a", domain.Reserve, 30))
	h, err := reader.History(ctx, "player", "coins", "", 25)
	if err != nil || len(h.Entries) != 2 {
		t.Fatal(h, err)
	}
	var held application.HistoryEntry
	for _, e := range h.Entries {
		if e.Reference == "repair-a" {
			held = e
		}
	}
	if held.Status != "held" || held.Units != 30 || held.At.IsZero() || held.TimeUnknown {
		t.Fatal(held)
	}
	funds(t, store, 100, 30)
	execute(t, s, command("capture-a", "repair-a", domain.Capture, 0))
	h, err = reader.History(ctx, "player", "coins", "", 25)
	if err != nil || len(h.Entries) != 2 {
		t.Fatal(h, err)
	}
	for _, e := range h.Entries {
		if e.Reference == "repair-a" && e.Status != "captured" {
			t.Fatal(e)
		}
	}
	execute(t, s, command("reserve-b", "repair-b", domain.Reserve, 20))
	execute(t, s, command("cancel-b", "repair-b", domain.Cancel, 0))
	h, err = reader.History(ctx, "player", "coins", "", 25)
	if err != nil || len(h.Entries) != 3 {
		t.Fatal(h, err)
	}
	statuses := map[string]string{}
	for _, e := range h.Entries {
		statuses[e.Reference] = e.Status
	}
	if statuses["fund"] != "credited" || statuses["repair-a"] != "captured" || statuses["repair-b"] != "released" {
		t.Fatal(statuses)
	}
	funds(t, store, 70, 0)
	// Pagination mixes journals and holds, and reuses the same owner-bound cursor.
	seen := map[string]bool{}
	cursor := ""
	for {
		page, err := reader.History(ctx, "player", "coins", cursor, 1)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range page.Entries {
			if seen[e.ID] {
				t.Fatal("duplicate history row", e)
			}
			seen[e.ID] = true
		}
		if page.Next == "" {
			break
		}
		cursor = page.Next
	}
	if len(seen) != 3 {
		t.Fatal(seen)
	}
}

func TestHistoryDoesNotInventTimeForLegacyHoldWithoutEvent(t *testing.T) {
	_, store := operatorDatabase(t)
	s := service(t, store)
	execute(t, s, command("fund", "fund", domain.Credit, 100))
	intent := domain.Intent{Producer: "inventory", ID: "legacy-hold", Kind: domain.Debit, State: domain.Reserved, Terms: &domain.Terms{Subject: "player", Asset: "coins", Units: 10, Purpose: domain.Spending, Evidence: "legacy"}, Version: 1}
	if err := store.Transact(ctx, func(tx application.Tx) error {
		if err := tx.LockAccounts([]domain.Account{domain.PlayerAccount(*intent.Terms)}); err != nil {
			return err
		}
		if _, err := tx.LockIntent(intent.Producer, intent.ID); err != nil {
			return err
		}
		return tx.SaveIntent(intent)
	}); err != nil {
		t.Fatal(err)
	}
	reader := application.Reader{Store: store, Authorizer: allowed, Producer: "inventory"}
	first, err := reader.History(ctx, "player", "coins", "", 1)
	if err != nil || len(first.Entries) != 1 || first.Next == "" {
		t.Fatal(first, err)
	}
	last, err := reader.History(ctx, "player", "coins", first.Next, 1)
	if err != nil || len(last.Entries) != 1 || last.Entries[0].Status != "held" || !last.Entries[0].TimeUnknown || last.Next != "" {
		t.Fatal(last, err)
	}
	public, err := (local.Reader{Service: reader, Assets: []string{"coins"}}).History(ctx, "player", "coins", first.Next, 1)
	if err != nil || len(public.Entries) != 1 || public.Entries[0].Status != "held" || public.Entries[0].At != "" {
		t.Fatal(public, err)
	}
}
