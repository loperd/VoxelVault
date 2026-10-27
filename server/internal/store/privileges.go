package store

import (
	"github.com/voxel-vault/api/platform/postgrespermissions"
)

// RuntimePrivileges covers catalog reads and the frozen economy fence. It grants no access to frozen legacy Inventory or Wallet data.
func RuntimePrivileges() postgrespermissions.Policy {
	p := postgrespermissions.Policy{}
	for _, name := range []string{"chest_types", "loot_items"} {
		p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "public", Name: name, Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}}})
	}
	p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "legacy_economy_cutover", Name: "snapshot", Privileges: []postgrespermissions.Privilege{{Action: "SELECT", Columns: []string{"singleton", "frozen", "source", "digest"}}}})
	return p
}
