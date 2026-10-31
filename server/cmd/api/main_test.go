package main

import (
	"strings"
	"testing"
)

func TestAPIRejectsWeakCredentialBeforeStorage(t *testing.T) {
	t.Setenv("IDENTITY_DATABASE_URL", "identity")
	t.Setenv("SECURITY_DATABASE_URL", "security")
	t.Setenv("GATEWAY_INTERNAL_TOKEN", "short")
	if err := run(); err == nil || !strings.Contains(err.Error(), "gateway peer credential") {
		t.Fatal(err)
	}
}
