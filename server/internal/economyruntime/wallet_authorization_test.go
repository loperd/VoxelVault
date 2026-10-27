package economyruntime_test

import (
	"context"
	"errors"
	"testing"

	"github.com/voxel-vault/api/internal/economyruntime"
	"github.com/voxel-vault/api/internal/ledger/adapters/authorization"
	"github.com/voxel-vault/api/internal/ledger/application"
	"github.com/voxel-vault/api/internal/ledger/domain"
)

func TestWalletRolesDoNotPermitFundingFromSettlementOrOpeningFromUsers(t *testing.T) {
	for _, producer := range []string{"inventory", "player-api", "legacy-opening", "unknown"} {
		_, err := economyruntime.WalletAuthorizer(nil, []authorization.Grant{{Producer: producer, Actions: []domain.Action{domain.FundTreasury}, Assets: []string{"coins"}, Subjects: []string{"system"}, Purposes: []domain.Purpose{domain.TreasuryOpening}, Treasuries: []string{"buyback"}, MaxUnits: 10}})
		if err == nil {
			t.Fatal("role allowed treasury funding", producer)
		}
	}
	auth, err := economyruntime.WalletAuthorizer(nil, []authorization.Grant{{Producer: "treasury-opening", Actions: []domain.Action{domain.FundTreasury}, Assets: []string{"coins"}, Subjects: []string{"system"}, Purposes: []domain.Purpose{domain.TreasuryOpening}, Treasuries: []string{"buyback"}, MaxUnits: 10}})
	if err != nil {
		t.Fatal(err)
	}
	terms := domain.Terms{Subject: "system", Asset: "coins", Units: 10, Purpose: domain.TreasuryOpening, Treasury: "buyback"}
	if err = auth.Authorize(context.Background(), "treasury-opening", domain.FundTreasury, &terms); err != nil {
		t.Fatal(err)
	}
	terms.Units = 11
	if err = auth.Authorize(context.Background(), "treasury-opening", domain.FundTreasury, &terms); !errors.Is(err, application.ErrForbidden) {
		t.Fatal(err)
	}
}
