package postgres_test

import (
	"context"
	"testing"

	"github.com/voxel-vault/api/inventory/adapters/postgres"
	"github.com/voxel-vault/api/inventory/adapters/postgres/migrations"
	"github.com/voxel-vault/api/platform/testpostgres"
)

func TestRulebookRevisionsAreNotRewrittenAndSeedKeepsTheActiveOne(t *testing.T) {
	ctx := context.Background()
	db := testpostgres.Database(t)
	if err := migrations.Up(ctx, db); err != nil {
		t.Fatal(err)
	}
	if _, err := postgres.ActiveRulebook(ctx, db); err == nil {
		t.Fatal("an unseeded database has no active rulebook")
	}
	if err := postgres.SeedRulebook(ctx, db, "r1", []byte(`{"revision":"r1"}`)); err != nil {
		t.Fatal(err)
	}
	if err := postgres.SeedRulebook(ctx, db, "r1", []byte(`{ "revision": "r1" }`)); err != nil {
		t.Fatalf("the same document seeds again: %v", err)
	}
	if err := postgres.SeedRulebook(ctx, db, "r1", []byte(`{"revision":"r1","x":1}`)); err == nil {
		t.Fatal("a known revision must not change")
	}
	if err := postgres.SeedRulebook(ctx, db, "r2", []byte(`{"revision":"r2"}`)); err != nil {
		t.Fatal(err)
	}
	doc, err := postgres.ActiveRulebook(ctx, db)
	if err != nil || string(doc) != `{"revision": "r1"}` {
		t.Fatalf("seed must not switch the active revision: %s %v", doc, err)
	}
}
