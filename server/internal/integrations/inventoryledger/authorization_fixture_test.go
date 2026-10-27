package inventoryledger_test

import (
	"context"
	"github.com/voxel-vault/api/internal/inventory/application"
	wallet "github.com/voxel-vault/api/internal/ledger/application"
)

type allowInventory struct{}

func (allowInventory) Authorize(context.Context, application.AccessRequest) (application.Decision, error) {
	return application.Decision{PolicyVersion: "test-fixture"}, nil
}

// Financial/lifecycle fixtures declare their trust explicitly. Dedicated policy
// tests exercise source approvals and production's deny-by-default boundary.
type allowIssuance struct{ wallet.Authorizer }

func (allowIssuance) AuthorizeIssuance(context.Context, string, wallet.Issuance) error { return nil }
