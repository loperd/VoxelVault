package store

import (
	"github.com/voxel-vault/api/platform/postgrespermissions"
)

// RuntimePrivileges covers the catalog reads. It grants no access to legacy Inventory or Wallet data.
func RuntimePrivileges() postgrespermissions.Policy {
	p := postgrespermissions.Policy{}
	for _, name := range []string{"chest_types", "loot_items"} {
		p.Tables = append(p.Tables, postgrespermissions.Table{Schema: "public", Name: name, Privileges: []postgrespermissions.Privilege{{Action: "SELECT"}}})
	}
	return p
}
