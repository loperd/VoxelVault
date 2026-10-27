package postgres_test

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/voxel-vault/api/identity/adapters/inbound/gatewayhttp"
	"github.com/voxel-vault/api/identity/adapters/inbound/local"
	"github.com/voxel-vault/api/identity/application"
)

func TestGatewayWireContractNeverAcceptsUntrustedHopOrBodyRoles(t *testing.T) {
	db, service := fixture(t)
	secret := strings.Repeat("s", 48)
	h, err := gatewayhttp.New(local.Sessions{Service: service, Principal: application.Principal{Kind: "service", ID: "gateway-a"}}, secret)
	if err != nil {
		t.Fatal(err)
	}
	request := func(path string, body any, token string) *httptest.ResponseRecorder {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest("POST", path, bytes.NewReader(raw))
		r.Header.Set("X-Internal-Token", token)
		r.Header.Set("X-User-Id", "admin")
		r.Header.Set("X-Role", "admin")
		r.Header.Set("X-Scopes", "admin:*")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	valid := map[string]any{"userId": "alice", "ttlSeconds": 3600, "userAgent": "test", "ip": "127.0.0.1"}
	if w := request("/internal/sessions/issue", valid, ""); w.Code != 401 {
		t.Fatal(w.Code, w.Body)
	}
	bad := map[string]any{"userId": "alice", "ttlSeconds": 3600, "roles": []string{"admin"}}
	if w := request("/internal/sessions/issue", bad, secret); w.Code != 400 {
		t.Fatal(w.Code, w.Body)
	}
	bad = map[string]any{"userId": "alice", "ttlSeconds": int64(1 << 62)}
	if w := request("/internal/sessions/issue", bad, secret); w.Code != 400 {
		t.Fatal(w.Code, w.Body)
	}
	if count(t, db, "sessions") != 0 {
		t.Fatal("invalid wire request changed Identity")
	}
	w := request("/internal/sessions/issue", valid, secret)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body)
	}
	var issued struct {
		SessionID  string `json:"sessionId"`
		RefreshJTI string `json:"refreshJti"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &issued); err != nil {
		t.Fatal(err)
	}
	w = request("/internal/sessions/refresh", map[string]string{"sessionId": issued.SessionID, "refreshJti": issued.RefreshJTI}, secret)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	var refresh struct {
		UserID     string `json:"userId"`
		RefreshJTI string `json:"refreshJti"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &refresh); err != nil || refresh.UserID != "alice" {
		t.Fatal(refresh, err)
	}
	w = request("/internal/sessions/refresh", map[string]string{"sessionId": issued.SessionID, "refreshJti": issued.RefreshJTI}, secret)
	if w.Code != 401 {
		t.Fatal("wire replay accepted", w.Code, w.Body)
	}
	w = request("/internal/sessions/refresh", map[string]string{"sessionId": issued.SessionID, "refreshJti": refresh.RefreshJTI}, secret)
	if w.Code != 401 {
		t.Fatal("wire replay did not persist revocation", w.Code, w.Body)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("sensitive wire response was cacheable")
	}
}
