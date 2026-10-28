package postgres_test

import "testing"

func TestTransferConfigIsStoredOnceAndNeverRewritten(t *testing.T) {
	_, store := operatorDatabase(t)
	if _, err := store.ActiveTransferConfig(ctx); err == nil {
		t.Fatal("an unseeded database has no active configuration")
	}
	if err := store.SeedTransferConfig(ctx, "v1", []byte(`{"Version":"v1"}`)); err != nil {
		t.Fatal(err)
	}
	if err := store.SeedTransferConfig(ctx, "v1", []byte(`{ "Version": "v1" }`)); err != nil {
		t.Fatalf("the same document seeds again: %v", err)
	}
	if err := store.SeedTransferConfig(ctx, "v1", []byte(`{"Version":"v1","x":1}`)); err == nil {
		t.Fatal("a known version must not change")
	}
	if err := store.SeedTransferConfig(ctx, "v2", []byte(`{"Version":"v2"}`)); err != nil {
		t.Fatal(err)
	}
	doc, err := store.ActiveTransferConfig(ctx)
	if err != nil || string(doc) != `{"Version": "v1"}` {
		t.Fatalf("seed must not switch the active version: %s %v", doc, err)
	}
}
