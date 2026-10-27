package main

import (
	"strings"
	"testing"
)

func TestAPIRejectsMissingDatabaseAndReusedCredentialsBeforeStorage(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	if err := run(); err == nil || !strings.Contains(err.Error(), "DATABASE_URL is required") {
		t.Fatal(err)
	}
	t.Setenv("DATABASE_URL", "invalid-dsn")
	t.Setenv("IDENTITY_DATABASE_URL", "identity")
	t.Setenv("SECURITY_DATABASE_URL", "security")
	t.Setenv("GATEWAY_INTERNAL_TOKEN", strings.Repeat("p", 32))
	t.Setenv("IDENTITY_INTERNAL_TOKEN", strings.Repeat("p", 32))
	if err := run(); err == nil || !strings.Contains(err.Error(), "must be distinct") {
		t.Fatal(err)
	}
	t.Setenv("IDENTITY_INTERNAL_TOKEN", "short")
	if err := run(); err == nil || !strings.Contains(err.Error(), "identity credential") {
		t.Fatal(err)
	}
}
