package migrations_test

import (
	"context"
	"database/sql"
	"testing"

	im "github.com/voxel-vault/api/identity/adapters/postgres/migrations"
	"github.com/voxel-vault/api/platform/testpostgres"
	sm "github.com/voxel-vault/api/security/adapters/postgres/migrations"
)

func exec(t *testing.T, db *sql.DB, q string) {
	t.Helper()
	if _, e := db.Exec(q); e != nil {
		t.Fatal(e)
	}
}
func oldIdentity(t *testing.T, db *sql.DB) {
	t.Helper()
	exec(t, db, `CREATE TABLE public.users(id text PRIMARY KEY,handle text UNIQUE,display_name text,created_at timestamptz,updated_at timestamptz,starter_granted_at timestamptz);
 CREATE TABLE public.identities(user_id text REFERENCES public.users(id),provider text,subject text,created_at timestamptz);
 CREATE TABLE public.credentials(user_id text REFERENCES public.users(id),credential_id text,data jsonb,created_at timestamptz,updated_at timestamptz);
 CREATE TABLE public.sessions(token_hash text,user_id text REFERENCES public.users(id));
 CREATE TABLE public.ceremonies(id text,user_id text REFERENCES public.users(id));
 CREATE TABLE public.o_auth_flows(state text);
 CREATE TABLE public.casbin_rule(ptype text,v0 text,v1 text);
 INSERT INTO public.users VALUES('original-player','tg_123','Original Player',now()-interval '1 year',now(),now()-interval '1 month');
 INSERT INTO public.identities VALUES('original-player','telegram','123',now());
 INSERT INTO public.credentials VALUES('original-player','credential-1','{"signCount":42}'::jsonb,now(),now());
 INSERT INTO public.sessions VALUES('old-cookie-hash','original-player');
 INSERT INTO public.casbin_rule VALUES('g','original-player','admin');`)
}
func TestRetirementPreservesDataAndRemovesOldTables(t *testing.T) {
	db := testpostgres.Database(t)
	oldIdentity(t, db)
	ctx := context.Background()
	if e := sm.Up(ctx, db); e != nil {
		t.Fatal(e)
	}
	for range 2 {
		if e := im.Up(ctx, db); e != nil {
			t.Fatal(e)
		}
	}
	var id, handle, name, external, credential, role string
	var starter bool
	if e := db.QueryRow(`SELECT a.id,a.handle,a.display_name,l.external_id,p.data->>'signCount',b.role,o.starter_granted_at IS NOT NULL FROM identity.accounts a JOIN identity.provider_links l ON l.account_id=a.id JOIN identity.passkeys p ON p.account_id=a.id JOIN security.role_bindings b ON b.subject=a.id JOIN public.economy_owners o ON o.id=a.id`).Scan(&id, &handle, &name, &external, &credential, &role, &starter); e != nil {
		t.Fatal(e)
	}
	if id != "original-player" || handle != "tg_123" || name != "Original Player" || external != "123" || credential != "42" || role != "admin" || !starter {
		t.Fatalf("migration lost data: %s %s %s %s %s %s %v", id, handle, name, external, credential, role, starter)
	}
	for _, table := range []string{"users", "identities", "credentials", "sessions", "ceremonies", "o_auth_flows", "casbin_rule"} {
		var exists bool
		if e := db.QueryRow(`SELECT to_regclass($1) IS NOT NULL`, "public."+table).Scan(&exists); e != nil || exists {
			t.Fatalf("obsolete table remains: %s (%v)", table, e)
		}
	}
	var n int
	if e := db.QueryRow(`SELECT count(*) FROM identity.events WHERE actor='identity-retirement'`).Scan(&n); e != nil || n != 1 {
		t.Fatalf("duplicate migration events: %d %v", n, e)
	}
	if e := db.QueryRow(`SELECT count(*) FROM identity.retirement`).Scan(&n); e != nil || n != 1 {
		t.Fatalf("retirement audit: %d %v", n, e)
	}
}
func TestRetirementFailsBeforeDroppingUnmigratedRolesAndResumes(t *testing.T) {
	db := testpostgres.Database(t)
	oldIdentity(t, db)
	ctx := context.Background()
	if e := im.Up(ctx, db); e == nil {
		t.Fatal("retirement accepted unmigrated Security roles")
	}
	var n int
	if e := db.QueryRow(`SELECT count(*) FROM public.users`).Scan(&n); e != nil || n != 1 {
		t.Fatal("failed migration destroyed source", n, e)
	}
	if e := sm.Up(ctx, db); e != nil {
		t.Fatal(e)
	}
	if e := im.Up(ctx, db); e != nil {
		t.Fatal(e)
	}
}
func TestUnexpectedForeignDependencyPreventsDestructiveRetirement(t *testing.T) {
	db := testpostgres.Database(t)
	oldIdentity(t, db)
	ctx := context.Background()
	exec(t, db, `CREATE TABLE public.unmigrated_dependency(account text REFERENCES public.users(id))`)
	if e := sm.Up(ctx, db); e != nil {
		t.Fatal(e)
	}
	if e := im.Up(ctx, db); e == nil {
		t.Fatal("DROP unexpectedly cascaded into foreign context")
	}
	var n int
	if e := db.QueryRow(`SELECT count(*) FROM public.users`).Scan(&n); e != nil || n != 1 {
		t.Fatal("source was lost", n, e)
	}
	exec(t, db, `DROP TABLE public.unmigrated_dependency`)
	if e := im.Up(ctx, db); e != nil {
		t.Fatal(e)
	}
}
