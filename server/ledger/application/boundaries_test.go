package application_test

import (
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestCoreDoesNotImportAdaptersOrForeignContexts(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate wallet source")
	}
	root := filepath.Dir(filepath.Dir(file))
	for _, layer := range []string{"domain", "application"} {
		err := filepath.WalkDir(filepath.Join(root, layer), func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			parsed, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
			if err != nil {
				return err
			}
			for _, spec := range parsed.Imports {
				dependency, err := strconv.Unquote(spec.Path.Value)
				if err != nil {
					return err
				}
				allowed := dependency == "github.com/voxel-vault/api/ledger/domain" && layer == "application"
				if strings.HasPrefix(dependency, "github.com/voxel-vault/") && !allowed {
					t.Errorf("%s imports foreign model or adapter %s", path, dependency)
				}
				if dependency == "database/sql" || strings.HasPrefix(dependency, "gorm.io/") || strings.HasPrefix(dependency, "github.com/jackc/") || dependency == "net/http" {
					t.Errorf("%s imports infrastructure %s", path, dependency)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
