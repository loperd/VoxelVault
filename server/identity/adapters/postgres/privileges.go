package postgres

import (
	"github.com/jackc/pgx/v5"
	"github.com/voxel-vault/api/platform/postgrespermissions"
)

func RuntimePrivileges() postgrespermissions.Policy {
	p := postgrespermissions.Policy{Sequences: []pgx.Identifier{{"identity", "session_events_id_seq"}, {"identity", "events_id_seq"}}}
	for _, table := range []string{"sessions", "refresh_tokens", "session_events", "accounts", "provider_links", "registrations", "events"} {
		p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "identity", Name: table, Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}, {Action: "INSERT"}}})
	}
	for table, columns := range map[string][]string{"sessions": {"current_hash", "revoked_at"}, "refresh_tokens": {"consumed_at"}, "registrations": {"completed_at", "receipt", "state", "attempts", "next_attempt_at", "last_error"}} {
		p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "identity", Name: table, Privileges: []postgrespermissions.Privilege{{Action: "UPDATE", Columns: columns}}})
	}
	p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "public", Name: "identity_schema_version", Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}}})
	return p
}
