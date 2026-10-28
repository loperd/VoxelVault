package postgres

import (
	"github.com/jackc/pgx/v5"
	"github.com/voxel-vault/api/platform/postgrespermissions"
)

func RuntimePrivileges() postgrespermissions.Policy {
	p := postgrespermissions.Policy{Sequences: []pgx.Identifier{{"security", "role_events_id_seq"}}}
	for _, name := range []string{"subject_registrations", "role_bindings", "role_events"} {
		p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "security", Name: name, Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}, {Action: "INSERT"}}})
	}
	// The role policy is read-only for the runtime: revisions change only through operator tools.
	for _, name := range []string{"policy_revisions", "policy_active"} {
		p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "security", Name: name, Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}}})
	}
	p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "public", Name: "security_schema_version", Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}}})
	return p
}
