package economycutover_test

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	cutover "github.com/voxel-vault/api/internal/economycutover"
	iv1 "github.com/voxel-vault/api/inventory/contracts/v1"
	wv1 "github.com/voxel-vault/api/ledger/contracts/v1"
)

func manifest(t *testing.T) cutover.Snapshot {
	t.Helper()
	s := cutover.Snapshot{Version: 1, Source: "production-fixture", FrozenAt: time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC), Owners: []cutover.Owner{{ID: "alice"}},
		Items:    []iv1.OpeningItem{{ID: "item", Owner: "alice", Definition: "compass", Condition: "heavy"}},
		Balances: []wv1.OpeningBalance{{Subject: "alice", Asset: "coins", Units: "9007199254740993"}},
		Chests:   []cutover.ChestArchive{{ID: "chest", Owner: "alice", Record: json.RawMessage(`{"id":"chest","user_id":"alice","seed":9007199254740993}`)}}}
	if err := s.Seal(); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestSnapshotIntegrityAndExactAmounts(t *testing.T) {
	s := manifest(t)
	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	roundtrip, err := cutover.Decode(bytes.NewReader(raw))
	if err != nil || roundtrip.Balances[0].Units != "9007199254740993" {
		t.Fatal(roundtrip, err)
	}
	// Object key order and pretty printing do not alter the archived record's identity.
	s.Chests[0].Record = json.RawMessage(`{ "seed": 9007199254740993, "user_id": "alice", "id": "chest" }`)
	if err := s.Check(); err != nil {
		t.Fatal(err)
	}
	s.Chests[0].Record = json.RawMessage(`{"id":"chest","user_id":"alice","seed":9007199254740992}`)
	if err := s.Check(); err == nil {
		t.Fatal("changed archived seed passed integrity check")
	}
}

func TestSnapshotRejectsInvalidInputsBeforeAnyTargetCall(t *testing.T) {
	for name, change := range map[string]func(*cutover.Snapshot){
		"negative":           func(s *cutover.Snapshot) { s.Balances[0].Units = "-1" },
		"noncanonical":       func(s *cutover.Snapshot) { s.Balances[0].Units = "01" },
		"overflow":           func(s *cutover.Snapshot) { s.Balances[0].Units = "9223372036854775808" },
		"duplicate balance":  func(s *cutover.Snapshot) { s.Balances = append(s.Balances, s.Balances[0]) },
		"duplicate item":     func(s *cutover.Snapshot) { s.Items = append(s.Items, s.Items[0]) },
		"orphan":             func(s *cutover.Snapshot) { s.Items[0].Owner = "missing" },
		"invalid condition":  func(s *cutover.Snapshot) { s.Items[0].Condition = "new" },
		"mismatched archive": func(s *cutover.Snapshot) { s.Chests[0].Record = json.RawMessage(`{"id":"other","user_id":"alice"}`) },
	} {
		t.Run(name, func(t *testing.T) {
			s := manifest(t)
			change(&s)
			if err := s.Seal(); err == nil {
				t.Fatal("invalid data sealed")
			}
		})
	}
	s := manifest(t)
	raw, _ := json.Marshal(s)
	for _, bad := range []string{string(raw) + ` {}`, strings.Replace(string(raw), `"version":1`, `"version":1,"unknown":true`, 1)} {
		if _, err := cutover.Decode(strings.NewReader(bad)); err == nil {
			t.Fatal("ambiguous document accepted")
		}
	}
}
