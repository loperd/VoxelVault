// Package domain owns Identity session state, without token signing or OAuth flows.
package domain

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

var ErrInvalid = errors.New("invalid identity request")
var ErrUnauthenticated = errors.New("identity session is not active")
var ErrForbidden = errors.New("identity permission denied")

func ValidID(id string) bool {
	return id != "" && len(id) <= 160 && utf8.ValidString(id) && strings.TrimSpace(id) == id && !strings.ContainsAny(id, "\x00\r\n")
}
func HashToken(token string) (string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != token {
		return "", ErrInvalid
	}
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:]), nil
}

type Session struct {
	ID, Subject, Issuer, CurrentHash, UserAgent, IP string
	CreatedAt, ExpiresAt                            time.Time
	RevokedAt                                       *time.Time
}

func (s Session) Active(now time.Time) bool {
	return s.RevokedAt == nil && !now.IsZero() && !now.Before(s.CreatedAt) && now.Before(s.ExpiresAt)
}

// A recognized consumed token proves replay. Unknown tokens cannot revoke a
// session. The caller must persist replay revocation even though access fails.
func (s Session) Rotate(presented, replacement string, known bool, now time.Time) (Session, string, error) {
	if !s.Active(now) {
		return s, "", ErrUnauthenticated
	}
	if presented == s.CurrentHash {
		if replacement == presented || len(replacement) != 64 {
			return s, "", ErrInvalid
		}
		s.CurrentHash = replacement
		return s, "refreshed", nil
	}
	if known {
		at := now.UTC()
		s.RevokedAt = &at
		return s, "replay_revoked", ErrUnauthenticated
	}
	return s, "", ErrUnauthenticated
}
