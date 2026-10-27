// Package resourcegrants evaluates token grant ceilings independently of live RBAC.
package resourcegrants

import (
	"path"
	"strings"
)

func Allows(grants []string, action, resource string) bool {
	if len(grants) > 1024 || action == "" || resource == "" {
		return false
	}
	for _, grant := range grants {
		if len(grant) > 4096 {
			continue
		}
		verb, pattern, ok := strings.Cut(grant, ":")
		if !ok || verb != action {
			continue
		}
		if matches, err := path.Match(pattern, resource); err == nil && matches {
			return true
		}
	}
	return false
}
