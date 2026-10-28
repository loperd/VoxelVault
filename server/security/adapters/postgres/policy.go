package postgres

import (
	"context"
	"database/sql"

	"github.com/voxel-vault/api/platform/configrevision"
)

var policyTables = configrevision.Tables{Revisions: "security.policy_revisions", Active: "security.policy_active", Key: "version"}

// ActivePolicy returns the JSON document of the active role policy.
func ActivePolicy(ctx context.Context, db *sql.DB) ([]byte, error) {
	return configrevision.Active(ctx, db, policyTables)
}

// SeedPolicy stores the version and makes it active only when none is.
func SeedPolicy(ctx context.Context, db *sql.DB, version string, doc []byte) error {
	return configrevision.Seed(ctx, db, policyTables, version, doc)
}
