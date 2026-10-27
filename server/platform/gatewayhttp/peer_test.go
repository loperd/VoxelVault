package gatewayhttp_test

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/voxel-vault/api/platform/gatewayhttp"
)

func TestOnlyOneMatchingGatewayCredentialAuthenticatesHop(t *testing.T) {
	secret := strings.Repeat("s", 48)
	peer, err := gatewayhttp.New(secret)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name    string
		headers []string
		allow   bool
	}{{"valid", []string{secret}, true}, {"missing", nil, false}, {"wrong", []string{strings.Repeat("x", 48)}, false}, {"duplicate", []string{secret, secret}, false}, {"comma-joined", []string{secret + "," + secret}, false}} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "http://api/internal/sessions/issue", nil)
			r.Header.Set("X-User-Id", "admin")
			r.Header.Set("X-Role", "admin")
			for _, v := range test.headers {
				r.Header.Add("X-Internal-Token", v)
			}
			if peer.Trusted(r) != test.allow {
				t.Fatal("unexpected hop authentication")
			}
		})
	}
	if _, err := gatewayhttp.New("short"); err == nil {
		t.Fatal("short gateway credential accepted")
	}
	r := httptest.NewRequest("POST", "http://api/internal/sessions/issue", nil)
	r.Header.Set("X-Internal-Token", "")
	if new(gatewayhttp.Peer).Trusted(r) {
		t.Fatal("unconfigured peer authenticated an empty credential")
	}
}
