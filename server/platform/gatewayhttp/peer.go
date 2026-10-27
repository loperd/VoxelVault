// Package gatewayhttp authenticates the shared gateway hop without interpreting
// OAuth/JWT or product roles. Product adapters consume only verified requests.
package gatewayhttp

import (
	"crypto/subtle"
	"errors"
	"net/http"
)

type Peer struct{ token []byte }

func New(token string) (*Peer, error) {
	if len(token) < 32 || len(token) > 512 {
		return nil, errors.New("gateway peer credential must contain 32 to 512 bytes")
	}
	return &Peer{token: []byte(token)}, nil
}
func (p *Peer) Trusted(r *http.Request) bool {
	if p == nil || len(p.token) < 32 {
		return false
	}
	values := r.Header.Values("X-Internal-Token")
	if len(values) != 1 {
		return false
	}
	value := []byte(values[0])
	return len(value) == len(p.token) && subtle.ConstantTimeCompare(value, p.token) == 1
}
