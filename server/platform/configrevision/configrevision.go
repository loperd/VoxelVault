// Package configrevision stores a context's configuration as revisions that are never
// rewritten, plus one active pointer. Each context owns its own pair of tables.
package configrevision

import (
	"context"
	"database/sql"
	"fmt"
)

// Tables names a context's revision table, its single-row active table and the key column
// both share. They are code constants, never user input.
type Tables struct{ Revisions, Active, Key string }

// Active returns the JSON document of the active revision.
func Active(ctx context.Context, db *sql.DB, t Tables) ([]byte, error) {
	var doc []byte
	err := db.QueryRowContext(ctx, `SELECT r.document FROM `+t.Active+` a JOIN `+t.Revisions+` r USING(`+t.Key+`)`).Scan(&doc)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("no active configuration in %s; run economy-seed", t.Revisions)
	}
	return doc, err
}

// Seed stores the revision and makes it active only when none is. A known revision must
// carry the same document.
func Seed(ctx context.Context, db *sql.DB, t Tables, key string, doc []byte) error {
	if key == "" {
		return fmt.Errorf("configuration revision is required")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT INTO `+t.Revisions+`(`+t.Key+`,document) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING`, key, doc); err != nil {
		return err
	}
	var same bool
	if err = tx.QueryRowContext(ctx, `SELECT document=$2::jsonb FROM `+t.Revisions+` WHERE `+t.Key+`=$1`, key, doc).Scan(&same); err != nil {
		return err
	}
	if !same {
		return fmt.Errorf("configuration revision %s exists with a different document", key)
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO `+t.Active+`(singleton,`+t.Key+`) VALUES(true,$1) ON CONFLICT DO NOTHING`, key); err != nil {
		return err
	}
	return tx.Commit()
}
