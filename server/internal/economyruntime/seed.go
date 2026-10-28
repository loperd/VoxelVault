package economyruntime

import (
	"context"
	"database/sql"

	lpg "github.com/voxel-vault/api/ledger/adapters/postgres"
)

// SeedLedger stores the transfer configuration and opens every account it names. It is
// the only place accounts come into being; startup only checks that they exist.
func SeedLedger(ctx context.Context, db *sql.DB, doc []byte) error {
	spec, err := ParseTransferConfig(doc)
	if err != nil {
		return err
	}
	store := lpg.New(db)
	if err = store.SeedTransferConfig(ctx, spec.Version, doc); err != nil {
		return err
	}
	for _, a := range spec.RequiredAccounts() {
		if err = store.OpenAccount(ctx, a); err != nil {
			return err
		}
	}
	return nil
}
