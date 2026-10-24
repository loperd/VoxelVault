package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/voxel-vault/api/internal/inventory/domain/rulebook"
	"github.com/voxel-vault/api/internal/rulebookjson"
)

func TestEveryRulebookItemHasObjectArt(t *testing.T) {
	rb, err := rulebookjson.Load("../../config/economy.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, chestType := range rb.Types() {
		for _, item := range chestType.Pool {
			if _, ok := itemShapes[item.Glyph]; !ok {
				t.Errorf("%s (glyph %q) has no object silhouette", item.ID, item.Glyph)
			}
		}
	}
}

// Items the rulebook added after the loot_items seed still get their icon, without the database.
func TestItemImageServesRulebookItems(t *testing.T) {
	rb, err := rulebookjson.Load("../../config/economy.json")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{rulebook: func() *rulebook.Rulebook { return rb }}
	for _, id := range []string{"ender-purpur", "ender-lantern", "ender-islands", "ender-shell-blade"} {
		req := httptest.NewRequest("GET", "/api/v1/items/"+id+"/image.svg", nil)
		req.SetPathValue("itemID", id)
		rec := httptest.NewRecorder()
		s.itemImage(rec, req)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "<svg") {
			t.Errorf("%s: %d %.60s", id, rec.Code, rec.Body.String())
		}
	}
}
