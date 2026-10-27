package integration_test

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/voxel-vault/api/internal/identity/adapters/inbound/gatewayhttp"
	"github.com/voxel-vault/api/internal/identity/adapters/inbound/local"

	"github.com/voxel-vault/api/internal/identity/adapters/postgres"

	"github.com/voxel-vault/api/internal/identity/application"
	"github.com/voxel-vault/api/internal/identityruntime"
)

func TestCompleteGatewayBackendWireContractsUseIndependentContextStores(t *testing.T) {
	f := setup(t)
	sessions := f.accounts
	auth, err := identityruntime.Authorizer("gateway")
	if err != nil {
		t.Fatal(err)
	}
	principal := application.Principal{Kind: "service", ID: "gateway"}
	client := local.Sessions{Service: application.Service{Store: postgres.Store{DB: sessions}, Directory: postgres.Registry{DB: f.accounts}, Authorizer: auth, Clock: time.Now, ID: newID, Token: func() (string, error) {
		raw := make([]byte, 32)
		_, err := rand.Read(raw)
		return base64.RawURLEncoding.EncodeToString(raw), err
	}}, Principal: principal}
	secret := strings.Repeat("s", 48)
	h, err := gatewayhttp.New(client, secret, local.Accounts{Service: f.service, Principal: principal})
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path string, body any, token string, want int) map[string]any {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(raw))
		r.Header.Set("X-Internal-Token", token)
		r.Header.Set("X-Role", "admin")
		r.Header.Set("X-User-Id", "spoofed")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body)
		}
		var value map[string]any
		if err = json.Unmarshal(w.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("identity response was cacheable")
		}
		return value
	}
	input := map[string]any{"provider": "telegram", "externalId": "verified-subject", "displayName": "Player", "username": "player"}
	request("POST", "/internal/auth/resolve", input, "", 401)
	request("POST", "/internal/auth/resolve", input, strings.Repeat("p", 48), 401)
	bad := map[string]any{"provider": "telegram", "externalId": "verified-subject", "role": "admin"}
	request("POST", "/internal/auth/resolve", bad, secret, 400)
	if count(t, f.accounts, `SELECT count(*) FROM identity.accounts`) != 0 {
		t.Fatal("untrusted wire request created account")
	}
	resolved := request("POST", "/internal/auth/resolve", input, secret, 200)
	id, ok := resolved["userId"].(string)
	if !ok || id == "" {
		t.Fatal(resolved)
	}
	if len(resolved["memberships"].([]any)) != 0 {
		t.Fatal("fictional organisation created")
	}
	permissions := request("POST", "/internal/auth/permissions", map[string]string{"userId": id}, secret, 200)
	if len(permissions["scopes"].([]any)) != 2 {
		t.Fatal(permissions)
	}
	catalog := request("GET", "/internal/auth/scopes", nil, secret, 200)
	if len(catalog["scopes"].([]any)) != 3 {
		t.Fatal(catalog)
	}
	issued := request("POST", "/internal/sessions/issue", map[string]any{"userId": id, "ttlSeconds": 3600, "userAgent": "test", "ip": "127.0.0.1"}, secret, 201)
	request("POST", "/internal/sessions/validate", map[string]any{"userId": id, "sessionId": issued["sessionId"]}, secret, 200)
	linked := request("POST", "/internal/auth/link", map[string]any{"userId": id, "sessionId": issued["sessionId"], "scopes": []string{"LINK:/identity/accounts/" + id}, "provider": "google", "externalId": "google-subject", "username": "user"}, secret, 200)
	if linked["ok"] != true {
		t.Fatal(linked)
	}
	if _, err = f.security.Exec(`DELETE FROM security.role_bindings WHERE subject=$1`, id); err != nil {
		t.Fatal(err)
	}
	request("POST", "/internal/auth/link", map[string]any{"userId": id, "sessionId": issued["sessionId"], "scopes": []string{"LINK:/identity/accounts/" + id}, "provider": "google", "externalId": "another"}, secret, 403)
	request("POST", "/internal/auth/resolve", input, secret, 200)
	permissions = request("POST", "/internal/auth/permissions", map[string]string{"userId": id}, secret, 200)
	if len(permissions["scopes"].([]any)) != 0 {
		t.Fatal("wire retry restored role", permissions)
	}
}
