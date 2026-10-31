package main

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestDropRemovesLegacyStorageAndRepeats(t *testing.T) {
	dsn := os.Getenv("TEST_WALLET_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_WALLET_DATABASE_URL must permit disposable test databases")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	name := "legacy_drop_test"
	if _, err = db.Exec(`DROP DATABASE IF EXISTS ` + name); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE DATABASE ` + name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Exec(`DROP DATABASE IF EXISTS ` + name + ` WITH (FORCE)`) })
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	target, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	for _, q := range []string{`CREATE TABLE public.chest_types(id int)`, `CREATE TABLE public.economy_owners(id int)`, `CREATE TABLE public.users(id int)`, `CREATE SCHEMA legacy_economy_cutover`, `CREATE TABLE legacy_economy_cutover.snapshot(id int)`} {
		if _, err = target.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err = run(context.Background(), target); err != nil {
			t.Fatal(err)
		}
	}
	var left int
	if err = target.QueryRow(`SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND (n.nspname='legacy_economy_cutover' OR c.relname IN ('chest_types','economy_owners'))`).Scan(&left); err != nil || left != 0 {
		t.Fatal("legacy storage left", left, err)
	}
	if err = target.QueryRow(`SELECT count(*) FROM public.users`).Scan(&left); err != nil {
		t.Fatal("unrelated table was dropped", err)
	}
}
