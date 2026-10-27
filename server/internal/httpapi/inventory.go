package httpapi

import (
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	iv1 "github.com/voxel-vault/api/inventory/contracts/v1"
	"github.com/voxel-vault/api/inventory/domain/rulebook"
)

// Chests and items exist only on the server, and the server alone decides what happens to them.
// A player gets chests from the server (the starter grant on the first inventory read, an admin
// grant) and opens what they own: claim a chest for one opening session (the server lands it and
// says what the fall did), then open it (the server says whether it broke or what dropped, and
// puts the drop into the player's items). The client only draws those outcomes.

type contentDTO struct {
	Item   itemDTO `json:"item"`
	Weight float64 `json:"weight"`
}

type traitDTO struct {
	ID        string  `json:"id"`
	Intensity float64 `json:"intensity"`
	Seed      uint32  `json:"seed"`
}

type originDTO struct {
	Source  string   `json:"source"`
	Parents []string `json:"parents,omitempty"`
}

type dropDTO struct {
	Item  itemDTO `json:"item"`
	State string  `json:"state"`
}

type chestDTO struct {
	ID          string       `json:"id"`
	CaseID      string       `json:"caseId"`
	Status      string       `json:"status"`
	Seed        uint64       `json:"seed"`
	Revision    string       `json:"revision"`
	Contents    []contentDTO `json:"contents"`
	Traits      []traitDTO   `json:"traits"`
	Rarity      string       `json:"rarity"`
	Condition   float64      `json:"condition"`
	Origin      originDTO    `json:"origin"`
	SessionID   string       `json:"sessionId,omitempty"`
	Drop        *dropDTO     `json:"drop,omitempty"`
	DestroyedAt string       `json:"destroyedAt,omitempty"`
	OpenedAt    *time.Time   `json:"openedAt,omitempty"`
}

type ownedItemDTO struct {
	ID     string  `json:"id"`
	Item   itemDTO `json:"item"`
	State  string  `json:"state"`
	Origin string  `json:"origin"`
}

// mergeOddsDTO is, in percent, what merging two chests would likely make: each trait's chance to
// stay and to rise a tier, and of the items the two hold together, how many the new one keeps.
type mergeOddsDTO struct {
	Traits   []traitOddsDTO  `json:"traits"`
	Contents contentsOddsDTO `json:"contents"`
}

type traitOddsDTO struct {
	ID      string  `json:"id"`
	Keep    float64 `json:"keep"`
	Upgrade float64 `json:"upgrade"`
}

type contentsOddsDTO struct {
	Total int     `json:"total"`
	Kept  int     `json:"kept"`
	Keep  float64 `json:"keep"`
}

// percent is a weight's share of the total in percent: an item's chance to drop.
func percent(weight, total float64) float64 {
	if total <= 0 {
		return 0
	}
	return math.Round(weight/total*10000) / 100
}

// rulebookItemDTO describes an item by the rulebook; one the rulebook no longer has keeps its id.
func rulebookItemDTO(rb *rulebook.Rulebook, id string, chance float64) itemDTO {
	item, _, ok := rb.Item(id)
	if !ok {
		return itemDTO{ID: id, Title: id, Image: "/api/v1/items/" + id + "/image.svg", Chance: chance}
	}
	return itemDTO{ID: item.ID, Title: item.Title, Image: itemImageURL(item.ID, item.Glyph), Type: item.Rarity, Chance: chance}
}

func sessionBody(w http.ResponseWriter, r *http.Request) (string, bool) {
	var body struct {
		SessionID string `json:"sessionId"`
	}
	if !decode(w, r, &body) || strings.TrimSpace(body.SessionID) == "" || len(body.SessionID) > 128 {
		writeError(w, 400, "invalid sessionId")
		return "", false
	}
	return body.SessionID, true
}

func pairBody(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	var body struct {
		A string `json:"a"`
		B string `json:"b"`
	}
	if !decode(w, r, &body) || body.A == "" || body.B == "" || len(body.A) > 128 || len(body.B) > 128 {
		writeError(w, 400, "invalid pair")
		return "", "", false
	}
	return body.A, body.B, true
}

// parseGrants reads "type:count,type:count"; types the rulebook does not have and non-positive
// counts are errors. The issuance limit is economyruntime.StarterPolicy's, checked at startup.
func parseGrants(rb *rulebook.Rulebook, value string) ([]iv1.Grant, error) {
	var grants []iv1.Grant
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		chestType, countText, ok := strings.Cut(part, ":")
		chestType = strings.TrimSpace(chestType)
		count, err := strconv.Atoi(strings.TrimSpace(countText))
		if _, known := rb.Type(chestType); !ok || err != nil || !known || count < 1 {
			return nil, fmt.Errorf("invalid chest grant %q", part)
		}
		grants = append(grants, iv1.Grant{Type: chestType, Count: count})
	}
	return grants, nil
}
