package main

import (
	"fmt"
	"github.com/voxel-vault/api/platform/migrationcmd"
	"github.com/voxel-vault/api/security/adapters/postgres/migrations"
	"os"
)

func main() {
	if err := migrationcmd.Run("SECURITY_DATABASE_URL", "Security", migrations.Up); err != nil {
		fmt.Fprintln(os.Stderr, "Security migration failed:", err)
		os.Exit(1)
	}
}
