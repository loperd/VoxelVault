package httpapi

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/voxel-vault/api/internal/rulebookjson"
	"github.com/voxel-vault/api/inventory/domain/rulebook"
)

func TestRelicCatalogChancesSumToOneHundredPercent(t *testing.T) {
	rb, err := rulebookjson.Load("../../config/economy.json")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{rulebook: func() *rulebook.Rulebook { return rb }}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/cases/relic/catalog", nil)
	r.SetPathValue("caseID", "relic")
	w := httptest.NewRecorder()
	s.caseCatalog(w, r)
	var items []itemDTO
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &items) != nil || len(items) != 12 {
		t.Fatalf("catalog: HTTP %d %s", w.Code, w.Body.String())
	}
	var chance float64
	for _, item := range items {
		if !strings.HasPrefix(item.ID, "relic-") || item.Image == "" || item.Chance <= 0 {
			t.Fatalf("invalid catalog item: %+v", item)
		}
		chance += item.Chance
	}
	// The API rounds each displayed probability to two decimal places.
	if math.Abs(chance-100) > .005*float64(len(items)) {
		t.Fatalf("catalog chances sum to %v", chance)
	}
}
