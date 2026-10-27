package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

// Optional real-Postgres backend for the browser acceptance check. Synthetic
// gateway credentials stay inside the disposable test fixture and never enter
// the production binary. The external browser runner creates <path>.stop.
func TestTransferBrowserFixture(t *testing.T) {
	path := os.Getenv("WALLET_BROWSER_FIXTURE")
	if path == "" {
		t.Skip("WALLET_BROWSER_FIXTURE enables the browser acceptance fixture")
	}
	f := httpStack(t, true)
	server := httptest.NewServer(f.server.Handler())
	t.Cleanup(server.Close)
	config := struct {
		URL     string            `json:"url"`
		Headers map[string]string `json:"headers"`
	}{
		URL: server.URL,
		Headers: map[string]string{
			"X-Internal-Token": fixtureToken,
			"X-User-Id":        "alice",
			"X-Session-Id":     f.sessions["alice"],
			"X-Scopes":         fixtureScopes(f, "alice"),
			"Origin":           "http://localhost",
		},
	}
	raw, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Error(err)
		}
	})
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(10 * time.Minute)
	defer deadline.Stop()
	for {
		select {
		case <-ticker.C:
			if _, err := os.Stat(path + ".stop"); err == nil {
				return
			}
		case <-deadline.C:
			t.Fatal("browser acceptance fixture timed out")
		}
	}
}
