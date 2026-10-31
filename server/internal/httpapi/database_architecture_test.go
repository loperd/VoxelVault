package httpapi

import (
	"database/sql"
	"testing"
)

// Guard the agreed architecture on the actual migrated schemas. PostgreSQL's internal FK machinery is not custom code.
func TestMigratedSchemasHaveNoCustomDatabaseCode(t *testing.T) {
	f := httpStack(t, false)
	for _, db := range []*sql.DB{f.source, f.idb, f.wdb} {
		for _, query := range []string{
			`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','inventory','wallet')`,
			`SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('public','inventory','wallet')`,
		} {
			var count int
			if err := db.QueryRow(query).Scan(&count); err != nil || count != 0 {
				t.Fatalf("custom executable database code: count=%d error=%v", count, err)
			}
		}
	}
}
