package economyruntime

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/voxel-vault/api/internal/rulebookjson"
	ipg "github.com/voxel-vault/api/inventory/adapters/postgres"
	"github.com/voxel-vault/api/inventory/domain/rulebook"
)

// LoadRulebook reads the active rulebook revision from the Inventory database.
func LoadRulebook(ctx context.Context, inventoryDSN string) (*rulebook.Rulebook, error) {
	if inventoryDSN == "" {
		return nil, fmt.Errorf("INVENTORY_DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", inventoryDSN)
	if err != nil {
		return nil, fmt.Errorf("invalid INVENTORY_DATABASE_URL")
	}
	defer db.Close()
	doc, err := ipg.ActiveRulebook(ctx, db)
	if err != nil {
		return nil, err
	}
	return rulebookjson.Parse(doc)
}
