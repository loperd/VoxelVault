package postgres

import (
	"github.com/jackc/pgx/v5"
	"github.com/voxel-vault/api/platform/postgrespermissions"
)

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
	// Configuration is read-only for the runtime: revisions change only through operator tools.
	for _, name := range []string{"transfer_config_revisions", "transfer_config_active"} {
		p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "ledger", Name: name, Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}}})
	}
	// Admin requests: the runtime serves the internal endpoint but cannot add keys or rewrite signatures and audit rows.
	for _, name := range []string{"admin_requests", "admin_signatures", "admin_audit"} {
		p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "ledger", Name: name, Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}, {Action: "INSERT"}}})
	}
	p.Tables = append(p.Tables,
		postgrespermissions.Table{Schema: "ledger", Name: "admin_keys", Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}}},
		postgrespermissions.Table{Schema: "ledger", Name: "admin_requests", Privileges: []postgrespermissions.Privilege{{Action: "UPDATE", Columns: []string{"executed_at"}}}},
	)
	p.Sequences = append(p.Sequences, pgx.Identifier{"ledger", "admin_audit_seq_seq"})
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
