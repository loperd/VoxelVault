// Package postgrespermissions applies explicit adapter-owned runtime grants. It has
// no domain types, role provisioning, default grants or application startup hooks.
package postgrespermissions

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

type Privilege struct {
	Action  string
	Columns []string // Empty means a whole-table grant.
}
type Table struct {
	Schema, Name string
	Privileges   []Privilege
}
type Policy struct {
	Tables    []Table
	Sequences []pgx.Identifier // USAGE only: nextval/currval, never setval.
	// Revoke lists whole-table grants an earlier release may have left to this role
	// (a renamed schema keeps its old ACLs). Only the listed ones are removed; anything
	// else unexpected still fails the audit.
	Revoke []Table
}

func (p Policy) allows(schema, table, action, column string) bool {
	for _, t := range p.Tables {
		if t.Schema != schema || t.Name != table {
			continue
		}
		for _, grant := range t.Privileges {
			if grant.Action == action && (len(grant.Columns) == 0 || column != "" && slices.Contains(grant.Columns, column)) {
				return true
			}
		}
	}
	return false
}

// Apply requires a dedicated, pre-created non-owner role without memberships or
// elevated cluster privileges. Existing excessive data privileges reject the whole
// transaction; this command never silently revokes other applications' grants.
func Apply(ctx context.Context, db *sql.DB, role string, p Policy) error {
	if role == "" || len(role) > 63 || strings.ContainsRune(role, 0) || role == "PUBLIC" || len(p.Tables) == 0 {
		return fmt.Errorf("a dedicated runtime role and explicit table policy are required")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var oid int64
	var unsafe bool
	err = tx.QueryRowContext(ctx, `SELECT r.oid::bigint,
 r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid)
 OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid)
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid)
 OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid)
 OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid)
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
 AND has_function_privilege(r.oid,p.oid,'EXECUTE'))
 OR has_database_privilege(r.oid,current_database(),'CREATE')
 OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
 AND has_schema_privilege(r.oid,n.oid,'CREATE'))
 FROM pg_roles r WHERE r.rolname=$1`, role).Scan(&oid, &unsafe)
	if err == sql.ErrNoRows {
		return fmt.Errorf("runtime role must already exist")
	}
	if err != nil {
		return err
	}
	if unsafe {
		return fmt.Errorf("runtime role must not own objects, inherit roles, execute security-definer functions or have elevated/create privileges")
	}
	quoted := pgx.Identifier{role}.Sanitize()
	schemas := map[string]bool{}
	for _, t := range p.Tables {
		if !schemas[t.Schema] {
			if _, err = tx.ExecContext(ctx, `GRANT USAGE ON SCHEMA `+pgx.Identifier{t.Schema}.Sanitize()+` TO `+quoted); err != nil {
				return err
			}
			schemas[t.Schema] = true
		}
		for _, grant := range t.Privileges {
			if !slices.Contains([]string{"SELECT", "INSERT", "UPDATE", "DELETE"}, grant.Action) || len(grant.Columns) > 0 && grant.Action == "DELETE" {
				return fmt.Errorf("invalid runtime privilege policy")
			}
			privilege := grant.Action
			if len(grant.Columns) > 0 {
				var columns []string
				for _, col := range grant.Columns {
					columns = append(columns, pgx.Identifier{col}.Sanitize())
				}
				privilege += " (" + strings.Join(columns, ",") + ")"
			}
			if _, err = tx.ExecContext(ctx, `GRANT `+privilege+` ON TABLE `+pgx.Identifier{t.Schema, t.Name}.Sanitize()+` TO `+quoted); err != nil {
				return err
			}
		}
	}
	for _, sequence := range p.Sequences {
		if _, err = tx.ExecContext(ctx, `GRANT USAGE ON SEQUENCE `+sequence.Sanitize()+` TO `+quoted); err != nil {
			return err
		}
	}
	for _, t := range p.Revoke {
		for _, r := range t.Privileges {
			if !slices.Contains([]string{"SELECT", "INSERT", "UPDATE", "DELETE"}, r.Action) || len(r.Columns) > 0 {
				return fmt.Errorf("invalid runtime revoke policy")
			}
			if _, err = tx.ExecContext(ctx, `REVOKE `+r.Action+` ON TABLE `+pgx.Identifier{t.Schema, t.Name}.Sanitize()+` FROM `+quoted); err != nil {
				return err
			}
		}
	}
	if err = p.audit(ctx, tx, oid); err != nil {
		return err
	}
	return tx.Commit()
}

func (p Policy) audit(ctx context.Context, tx *sql.Tx, oid int64) error {
	// Check effective privileges, including PUBLIC grants, across this database.
	// Column checks also detect grants that has_table_privilege alone cannot see.
	rows, err := tx.QueryContext(ctx, `SELECT n.nspname,c.relname,v.action,'' AS column_name,
 has_table_privilege($1::oid,c.oid,v.action||' WITH GRANT OPTION')
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) v(action)
 WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
 AND has_table_privilege($1::oid,c.oid,v.action)
 UNION ALL
 SELECT n.nspname,c.relname,v.action,a.attname,
 has_column_privilege($1::oid,c.oid,a.attnum,v.action||' WITH GRANT OPTION')
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) v(action)
 WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
 AND has_column_privilege($1::oid,c.oid,a.attnum,v.action)`, oid)
	if err != nil {
		return err
	}
	for rows.Next() {
		var schema, table, action, col string
		var canGrant bool
		if err := rows.Scan(&schema, &table, &action, &col, &canGrant); err != nil {
			rows.Close()
			return err
		}
		if canGrant || !p.allows(schema, table, action, col) {
			rows.Close()
			return fmt.Errorf("runtime role has unexpected %s privilege on %s.%s (%s)", action, schema, table, col)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	rows, err = tx.QueryContext(ctx, `SELECT n.nspname,c.relname,v.action,
 has_sequence_privilege($1::oid,c.oid,v.action||' WITH GRANT OPTION')
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) v(action)
 WHERE c.relkind='S' AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
 AND has_sequence_privilege($1::oid,c.oid,v.action)`, oid)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var schema, name, action string
		var canGrant bool
		if err := rows.Scan(&schema, &name, &action, &canGrant); err != nil {
			return err
		}
		if canGrant || action != "USAGE" || !slices.ContainsFunc(p.Sequences, func(id pgx.Identifier) bool { return slices.Equal(id, pgx.Identifier{schema, name}) }) {
			return fmt.Errorf("runtime role has unexpected %s privilege on sequence %s.%s", action, schema, name)
		}
	}
	return rows.Err()
}
