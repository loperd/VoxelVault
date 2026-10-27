package postgres

import "github.com/voxel-vault/api/internal/platform/postgrespermissions"

// RuntimePrivileges is Wallet-owned. Opening receipts and schema history are
// read-only; journals/postings have no runtime UPDATE or DELETE privileges.
func RuntimePrivileges() postgrespermissions.Policy {
	p := postgrespermissions.Policy{}
	for _, name := range []string{"transfer_quotes", "transfer_commands"} {
		p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "ledger", Name: name, Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}, {Action: "INSERT"}, {Action: "UPDATE", Columns: []string{"receipt"}}}})
	}
	// No UPDATE: a compromised API cannot lift a restriction.
	p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "ledger", Name: "account_restrictions", Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}, {Action: "INSERT"}}})
	p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "ledger", Name: "treasury_openings", Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}}})
	for _, name := range []string{"accounts", "commands", "intents", "holds", "journals", "postings", "outbox"} {
		p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "ledger", Name: name, Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}, {Action: "INSERT"}}})
	}
	for name, columns := range map[string][]string{
		"accounts": {"id"}, // Row locks require UPDATE on at least one column.
		"commands": {"receipt"}, "intents": {"body"},
		"outbox": {"delivered_at", "available_at", "lease_owner", "lease_until", "lease_fence", "attempts"},
	} {
		p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "ledger", Name: name, Privileges: []postgrespermissions.Privilege{{Action: "UPDATE", Columns: columns}}})
	}
	p.Tables = append(p.Tables,
		postgrespermissions.Table{Schema: "ledger", Name: "holds", Privileges: []postgrespermissions.Privilege{{Action: "UPDATE", Columns: []string{"status"}}}},
		postgrespermissions.Table{Schema: "ledger", Name: "opening_baseline", Privileges: []postgrespermissions.Privilege{{Action: "SELECT", Columns: []string{"singleton", "source", "digest"}}}},
		postgrespermissions.Table{Schema: "public", Name: "wallet_schema_version", Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}}},
	)
	// Holds were once deleted on release; the old grant survives the wallet->ledger rename.
	p.Revoke = []postgrespermissions.Table{{Schema: "ledger", Name: "holds", Privileges: []postgrespermissions.Privilege{{Action: "DELETE"}}}}
	return p
}
