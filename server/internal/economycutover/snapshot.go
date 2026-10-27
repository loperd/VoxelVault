// Package economycutover coordinates offline migration through published context ports.
// Its archive format is a migration artifact, never a shared runtime domain model.
package economycutover

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	iv1 "github.com/voxel-vault/api/inventory/contracts/v1"
	wv1 "github.com/voxel-vault/api/ledger/contracts/v1"
)

var ErrInvalid = errors.New("invalid economy migration snapshot")

type Owner struct {
	ID               string     `json:"id"`
	StarterGrantedAt *time.Time `json:"starterGrantedAt"`
}

// ChestArchive preserves the complete legacy record until the chest use cases move.
// Importing workshop items and balances does not claim to migrate these records.
type ChestArchive struct {
	ID     string          `json:"id"`
	Owner  string          `json:"owner"`
	Record json.RawMessage `json:"record"`
}
type Snapshot struct {
	Version  int                  `json:"version"`
	Source   string               `json:"source"`
	FrozenAt time.Time            `json:"frozenAt"`
	Owners   []Owner              `json:"owners"`
	Items    []iv1.OpeningItem    `json:"items"`
	Balances []wv1.OpeningBalance `json:"balances"`
	Chests   []ChestArchive       `json:"chests"`
	Digest   string               `json:"digest"`
}

func validID(s string) bool {
	return utf8.ValidString(s) && len(s) > 0 && len(s) <= 160 && strings.TrimSpace(s) == s && !strings.ContainsAny(s, "\x00\r\n")
}
func identity(parts ...string) string {
	b, _ := json.Marshal(parts)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func (s Snapshot) validate() error {
	if s.Version != 1 || !validID(s.Source) || s.FrozenAt.IsZero() {
		return ErrInvalid
	}
	owners := map[string]bool{}
	for _, o := range s.Owners {
		if !validID(o.ID) || owners[o.ID] {
			return ErrInvalid
		}
		owners[o.ID] = true
	}
	items := map[string]bool{}
	for _, i := range s.Items {
		if !validID(i.ID) || !owners[i.Owner] || !validID(i.Definition) || (i.Origin != "" && !validID(i.Origin)) || items[i.ID] {
			return ErrInvalid
		}
		switch i.Condition {
		case "intact", "slight", "heavy", "broken":
		default:
			return ErrInvalid
		}
		items[i.ID] = true
	}
	balances := map[string]bool{}
	for _, b := range s.Balances {
		n, err := strconv.ParseInt(b.Units, 10, 64)
		key := identity(b.Subject, b.Asset)
		if !owners[b.Subject] || !validID(b.Asset) || err != nil || n < 0 || strconv.FormatInt(n, 10) != b.Units || balances[key] {
			return ErrInvalid
		}
		balances[key] = true
	}
	chests := map[string]bool{}
	for _, c := range s.Chests {
		var row struct {
			ID    string `json:"id"`
			Owner string `json:"user_id"`
		}
		if !validID(c.ID) || !owners[c.Owner] || chests[c.ID] || json.Unmarshal(c.Record, &row) != nil || row.ID != c.ID || row.Owner != c.Owner {
			return ErrInvalid
		}
		chests[c.ID] = true
	}
	return nil
}
func (s Snapshot) hash() (string, error) {
	s.Digest = ""
	// Normalize archived JSON without converting large integer seeds into float64.
	s.Chests = append([]ChestArchive(nil), s.Chests...)
	for i, c := range s.Chests {
		dec := json.NewDecoder(bytes.NewReader(c.Record))
		dec.UseNumber()
		var v any
		if err := dec.Decode(&v); err != nil {
			return "", err
		}
		b, err := json.Marshal(v)
		if err != nil {
			return "", err
		}
		s.Chests[i].Record = b
	}
	b, err := json.Marshal(s)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}
func (s *Snapshot) Seal() error {
	if err := s.validate(); err != nil {
		return err
	}
	h, err := s.hash()
	s.Digest = h
	return err
}
func (s Snapshot) Check() error {
	if err := s.validate(); err != nil {
		return err
	}
	h, err := s.hash()
	if err != nil || h != s.Digest {
		return ErrInvalid
	}
	return nil
}
func Decode(r io.Reader) (Snapshot, error) {
	var s Snapshot
	d := json.NewDecoder(r)
	d.DisallowUnknownFields()
	if err := d.Decode(&s); err != nil {
		return s, err
	}
	var trailing any
	if err := d.Decode(&trailing); err != io.EOF {
		return s, ErrInvalid
	}
	return s, s.Check()
}

type Report struct {
	Source          string `json:"source"`
	Digest          string `json:"digest"`
	WalletImported  bool   `json:"walletImported"`
	ItemsImported   bool   `json:"itemsImported"`
	ArchivedChests  int    `json:"archivedChests"`
	APICutoverReady bool   `json:"apiCutoverReady"`
}

// Apply recovers forward after a lost reply or partial import using each context's
// durable, digest-pinned baseline receipt. No cross-context transaction is opened.
func Apply(ctx context.Context, s Snapshot, wallet wv1.OpeningClient, inventory iv1.OpeningClient) (Report, error) {
	r := Report{Source: s.Source, Digest: s.Digest, ArchivedChests: len(s.Chests)}
	if err := s.Check(); err != nil {
		return r, err
	}
	if wallet == nil || inventory == nil {
		return r, ErrInvalid
	}
	if err := wallet.ImportOpening(ctx, wv1.Opening{Source: s.Source, Digest: s.Digest, At: s.FrozenAt.Format(time.RFC3339Nano), Balances: s.Balances}); err != nil {
		return r, fmt.Errorf("wallet baseline: %w", err)
	}
	r.WalletImported = true
	if err := inventory.ImportItems(ctx, iv1.Opening{Source: s.Source, Digest: s.Digest, Items: s.Items}); err != nil {
		return r, fmt.Errorf("inventory baseline: %w", err)
	}
	r.ItemsImported = true
	return r, nil
}
