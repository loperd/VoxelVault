package legacy

import (
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/voxel-vault/api/internal/economycutover"
	v1 "github.com/voxel-vault/api/inventory/contracts/v1"
)

// ChestOpening translates only the frozen archive format into Inventory's published DTOs.
// It never reads the live source and never constructs an Inventory domain aggregate.
func ChestOpening(s economycutover.Snapshot) (v1.ChestsOpening, error) {
	r := v1.ChestsOpening{Source: s.Source, Digest: s.Digest}
	if err := s.Check(); err != nil {
		return r, err
	}
	for _, o := range s.Owners {
		x := v1.OpeningOwner{ID: o.ID}
		if o.StarterGrantedAt != nil {
			at := o.StarterGrantedAt.Format(time.RFC3339Nano)
			x.StarterGrantedAt = &at
		}
		r.Owners = append(r.Owners, x)
	}
	byOrigin := map[string][]v1.OpeningItem{}
	for _, item := range s.Items {
		if item.Origin != "" {
			byOrigin[item.Origin] = append(byOrigin[item.Origin], item)
		}
	}
	for _, archive := range s.Chests {
		var row struct {
			ID       string `json:"id"`
			Owner    string `json:"user_id"`
			Type     string `json:"case_id"`
			Seed     int64  `json:"seed"`
			Revision string `json:"revision"`
			Contents []struct {
				Item   string
				Weight float64
			} `json:"contents"`
			Traits []struct {
				ID        string
				Intensity float64
				Seed      uint32
			} `json:"traits"`
			Rarity      string     `json:"rarity"`
			Condition   float64    `json:"condition"`
			Source      string     `json:"origin_source"`
			Parents     []string   `json:"origin_parents"`
			Status      string     `json:"status"`
			Session     *string    `json:"session_id"`
			RewardID    *string    `json:"reward_id"`
			DropState   string     `json:"drop_state"`
			DestroyedAt string     `json:"destroyed_at"`
			CreatedAt   *time.Time `json:"created_at"`
			OpenedAt    *time.Time `json:"opened_at"`
		}
		if err := json.Unmarshal(archive.Record, &row); err != nil {
			return r, err
		}
		if row.ID != archive.ID || row.Owner != archive.Owner {
			return r, economycutover.ErrInvalid
		}
		x := v1.OpeningChest{ID: row.ID, Owner: row.Owner, Type: row.Type, Seed: strconv.FormatUint(uint64(row.Seed), 10), Revision: row.Revision, Rarity: row.Rarity, Condition: row.Condition, Source: row.Source, Parents: row.Parents, Status: row.Status, DestroyedAt: row.DestroyedAt, CreatedAt: s.FrozenAt.Format(time.RFC3339Nano)}
		if row.CreatedAt != nil {
			x.CreatedAt = row.CreatedAt.Format(time.RFC3339Nano)
		}
		if row.OpenedAt != nil {
			at := row.OpenedAt.Format(time.RFC3339Nano)
			x.OpenedAt = &at
		}
		if row.Session != nil {
			x.Session = *row.Session
		}
		for _, slot := range row.Contents {
			x.Contents = append(x.Contents, v1.ChestSlot{Item: slot.Item, Weight: slot.Weight})
		}
		for _, trait := range row.Traits {
			x.Traits = append(x.Traits, v1.ChestTrait{ID: trait.ID, Intensity: trait.Intensity, Seed: trait.Seed})
		}
		matches := byOrigin[row.ID]
		if len(matches) > 1 {
			return r, fmt.Errorf("ambiguous legacy reward for chest %s", row.ID)
		}
		if row.RewardID == nil && len(matches) > 0 {
			return r, fmt.Errorf("item exists without a recorded chest reward: %s", row.ID)
		}
		if row.RewardID != nil {
			condition := row.DropState
			if condition == "" && row.Revision == "" {
				condition = "intact"
			}
			x.Drop = &v1.ChestDrop{Item: *row.RewardID, Condition: condition}
			if len(matches) == 1 {
				item := matches[0]
				if item.Owner != row.Owner || item.Definition != *row.RewardID {
					return r, economycutover.ErrInvalid
				}
				item.Condition = condition
				x.Reward = &item
			}
		}
		r.Chests = append(r.Chests, x)
	}
	return r, nil
}
