package store

import (
	"fmt"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func Open(dsn string) (*gorm.DB, error) {
	db, err := OpenRuntime(dsn)
	if err != nil {
		return nil, err
	}
	if err := db.AutoMigrate(&EconomyOwner{}, &ChestType{}, &LootItem{}, &ChestInstance{}, &InventoryItem{}, &WalletBalance{}); err != nil {
		return nil, fmt.Errorf("migrate application schema: %w", err)
	}
	return db, nil
}

// OpenRuntime connects to an already provisioned database. API
// startup must not migrate or seed the legacy catalog with runtime credentials.
func OpenRuntime(dsn string) (*gorm.DB, error) {
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{TranslateError: true})
	if err != nil {
		return nil, fmt.Errorf("open PostgreSQL: %w", err)
	}
	return db, nil
}
