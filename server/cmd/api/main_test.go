package main

import (
	"strings"
	"testing"
)

func TestAPIRejectsMissingDatabaseAndWeakCredentialBeforeStorage(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	if err := run(); err == nil || !strings.Contains(err.Error(), "DATABASE_URL is required") {
		t.Fatal(err)
	}
	t.Setenv("DATABASE_URL", "invalid-dsn")
	t.Setenv("IDENTITY_DATABASE_URL", "identity")
	t.Setenv("SECURITY_DATABASE_URL", "security")
	t.Setenv("GATEWAY_INTERNAL_TOKEN", "short")
	if err := run(); err == nil || !strings.Contains(err.Error(), "gateway peer credential") {
		t.Fatal(err)
	}
}
