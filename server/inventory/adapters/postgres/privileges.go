package postgres

import "github.com/voxel-vault/api/platform/postgrespermissions"

func RuntimePrivileges() postgrespermissions.Policy {
	p := postgrespermissions.Policy{}
	for _, name := range []string{"instance_registry", "lifecycle_entries", "lifecycle_links"} {
		p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "inventory", Name: name, Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}, {Action: "INSERT"}}})
	}
	p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "inventory", Name: "instance_registry", Privileges: []postgrespermissions.Privilege{{Action: "UPDATE", Columns: []string{"version", "snapshot", "custody"}}}})
	for _, name := range []string{"items", "operations", "owners", "chests", "collection_commands", "inbox", "outbox"} {
		p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "inventory", Name: name, Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}, {Action: "INSERT"}}})
	}
	for name, columns := range map[string][]string{
		"items": {"condition", "status", "operation_id"}, "operations": {"body"},
		"owners": {"starter_granted_at"}, "chests": {"body"}, "collection_commands": {"result"},
		"inbox":  {"id"}, // SELECT FOR UPDATE needs an UPDATE privilege.
		"outbox": {"payload", "available_at", "lease_owner", "lease_until", "lease_fence", "attempts", "finished_at", "terminal_error"},
	} {
		p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "inventory", Name: name, Privileges: []postgrespermissions.Privilege{{Action: "UPDATE", Columns: columns}}})
	}
	for _, name := range []string{"opening_baseline", "chest_baseline"} {
		p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "inventory", Name: name, Privileges: []postgrespermissions.Privilege{{Action: "SELECT", Columns: []string{"singleton", "source", "digest"}}}})
	}
	// Configuration is read-only for the runtime: revisions change only through operator tools.
	for _, name := range []string{"rulebook_revisions", "rulebook_active"} {
		p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "inventory", Name: name, Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}}})
	}
	p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "public", Name: "inventory_schema_version", Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}}})
	return p
}
