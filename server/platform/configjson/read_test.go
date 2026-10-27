package configjson_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/voxel-vault/api/platform/configjson"
)

func TestReadEnforcesSizeSchemaAndSingleDocument(t *testing.T) {
	for _, test := range []struct {
		name, body string
		limit      int64
		allow      bool
	}{
		{"valid", `{"name":"queue"}`, 32, true},
		{"unknown", `{"typo":"queue"}`, 32, false},
		{"trailing", `{"name":"queue"} {}`, 32, false},
		{"too-large", `{"name":"queue"}`, 4, false},
		{"invalid-limit", `{}`, 0, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, []byte(test.body), 0600); err != nil {
				t.Fatal(err)
			}
			var target struct {
				Name string `json:"name"`
			}
			err := configjson.Read(path, test.limit, &target)
			if (err == nil) != test.allow {
				t.Fatal(err)
			}
		})
	}
}
