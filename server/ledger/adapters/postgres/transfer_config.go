package postgres

import (
	"context"

	"github.com/voxel-vault/api/platform/configrevision"
)

var transferConfigTables = configrevision.Tables{Revisions: "ledger.transfer_config_revisions", Active: "ledger.transfer_config_active", Key: "version"}

// ActiveTransferConfig returns the JSON document of the active transfer configuration.
func (s *Store) ActiveTransferConfig(ctx context.Context) ([]byte, error) {
	return configrevision.Active(ctx, s.db, transferConfigTables)
}

// SeedTransferConfig stores the version and makes it active only when none is.
func (s *Store) SeedTransferConfig(ctx context.Context, version string, doc []byte) error {
	return configrevision.Seed(ctx, s.db, transferConfigTables, version, doc)
}
