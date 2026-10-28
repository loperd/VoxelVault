package securityruntime_test

import (
	"context"
	"testing"

	"github.com/voxel-vault/api/internal/securityruntime"
	"github.com/voxel-vault/api/platform/testpostgres"
	"github.com/voxel-vault/api/security/adapters/postgres"
	"github.com/voxel-vault/api/security/adapters/postgres/migrations"
)

func TestRolePolicyIsStoredOnceAndRejectedWhenInvalid(t *testing.T) {
	ctx := context.Background()
	db := testpostgres.Database(t)
	if err := migrations.Up(ctx, db); err != nil {
		t.Fatal(err)
	}
	if _, err := postgres.ActivePolicy(ctx, db); err == nil {
		t.Fatal("an unseeded database has no active policy")
	}
	good := []byte(`{"version":"v1","roles":[{"id":"player"}]}`)
	if err := securityruntime.SeedPolicy(ctx, db, good); err != nil {
		t.Fatal(err)
	}
	if err := securityruntime.SeedPolicy(ctx, db, good); err != nil {
		t.Fatalf("the same document seeds again: %v", err)
	}
	if err := securityruntime.SeedPolicy(ctx, db, []byte(`{"version":"v1","roles":[{"id":"player"},{"id":"admin"}]}`)); err == nil {
		t.Fatal("a known version must not change")
	}
	for _, bad := range []string{`{"version":"v2","roles":[{"id":"player"}],"typo":1}`, `{"version":"v2","roles":[{"id":"a","parents":["missing"]}]}`} {
		if err := securityruntime.SeedPolicy(ctx, db, []byte(bad)); err == nil {
			t.Fatalf("invalid policy stored: %s", bad)
		}
	}
}
