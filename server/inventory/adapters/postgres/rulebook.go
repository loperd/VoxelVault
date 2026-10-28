package postgres

import (
	"context"
	"database/sql"

	"github.com/voxel-vault/api/platform/configrevision"
)

var rulebookTables = configrevision.Tables{Revisions: "inventory.rulebook_revisions", Active: "inventory.rulebook_active", Key: "revision"}

// ActiveRulebook returns the JSON document of the active rulebook revision.
func ActiveRulebook(ctx context.Context, db *sql.DB) ([]byte, error) {
	return configrevision.Active(ctx, db, rulebookTables)
}

// SeedRulebook stores the revision and makes it active only when none is.
func SeedRulebook(ctx context.Context, db *sql.DB, revision string, doc []byte) error {
	return configrevision.Seed(ctx, db, rulebookTables, revision, doc)
}
