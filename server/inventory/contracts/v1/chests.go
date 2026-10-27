package v1

import "context"

type OpeningOwner struct {
	ID               string  `json:"id"`
	StarterGrantedAt *string `json:"starterGrantedAt"`
}
type ChestSlot struct {
	Item   string  `json:"item"`
	Weight float64 `json:"weight"`
}
type ChestTrait struct {
	ID        string  `json:"id"`
	Intensity float64 `json:"intensity"`
	Seed      uint32  `json:"seed"`
}
type ChestDrop struct {
	Item      string `json:"item"`
	Condition string `json:"condition"`
}

// Chest is Inventory's published view, never a domain aggregate or legacy row.
type Chest struct {
	ID          string       `json:"id"`
	Owner       string       `json:"owner"`
	Type        string       `json:"type"`
	Seed        string       `json:"seed"`
	Revision    string       `json:"revision"`
	Contents    []ChestSlot  `json:"contents"`
	Traits      []ChestTrait `json:"traits"`
	Rarity      string       `json:"rarity"`
	Condition   float64      `json:"condition"`
	Source      string       `json:"source"`
	Parents     []string     `json:"parents"`
	Status      string       `json:"status"`
	Session     string       `json:"session"`
	Drop        *ChestDrop   `json:"drop"`
	DestroyedAt string       `json:"destroyedAt"`
	CreatedAt   string       `json:"createdAt"`
	OpenedAt    *string      `json:"openedAt"`
	Reward      *OpeningItem `json:"reward"`
}

type OpeningChest = Chest
type ChestsOpening struct {
	Source string         `json:"source"`
	Digest string         `json:"digest"`
	Owners []OpeningOwner `json:"owners"`
	Chests []OpeningChest `json:"chests"`
}
type ChestsOpeningClient interface {
	ImportChests(context.Context, ChestsOpening) error
}

// ChestsOpeningValidator is a pure local preflight port with no I/O or mutation.
type ChestsOpeningValidator interface {
	ValidateChestsOpening(context.Context, ChestsOpening) error
}
