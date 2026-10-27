// Package testpostgres supplies isolated disposable PostgreSQL databases to
// integration tests across contexts. Production code must not depend on it.
package testpostgres

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/url"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func Database(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		dsn = os.Getenv("TEST_WALLET_DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_POSTGRES_URL must allow disposable database creation")
	}
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		t.Fatal("test PostgreSQL connection must be a URL")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 12)
	if _, err = rand.Read(b); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	name := "context_test_" + hex.EncodeToString(b)
	if _, err = admin.ExecContext(context.Background(), `CREATE DATABASE `+name); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	u.Path = "/" + name
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		_, _ = admin.Exec(`DROP DATABASE ` + name)
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Close()
		if _, err := admin.Exec(`DROP DATABASE ` + name + ` WITH (FORCE)`); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	return db
}
