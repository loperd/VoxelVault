package v1

import "context"

type Item struct {
	ID          string `json:"id"`
	Owner       string `json:"owner"`
	Definition  string `json:"definition"`
	Condition   string `json:"condition"`
	Origin      string `json:"origin"`
	Status      string `json:"status"`
	OperationID string `json:"operationId,omitempty"`
}
type Grant struct {
	Type  string `json:"type"`
	Count int    `json:"count"`
}
type IssueRequest struct {
	Owner     string `json:"owner"`
	RequestID string `json:"requestId"`
	Type      string `json:"type"`
	Source    string `json:"source"`
	Count     int    `json:"count"`
}
type PairRequest struct {
	Owner     string `json:"owner"`
	RequestID string `json:"requestId"`
	A         string `json:"a"`
	B         string `json:"b"`
}
type Landing struct {
	Damage    *ChestTrait `json:"damage,omitempty"`
	Destroyed bool        `json:"destroyed"`
}
type Claimed struct {
	Chest   OpeningChest `json:"chest"`
	Landing *Landing     `json:"landing"`
}
type TraitOdds struct {
	ID      string  `json:"id"`
	Keep    float64 `json:"keep"`
	Upgrade float64 `json:"upgrade"`
}
type MergeOdds struct {
	Traits   []TraitOdds `json:"traits"`
	Contents int         `json:"contents"`
	Size     int         `json:"size"`
	ItemKeep float64     `json:"itemKeep"`
}

// CollectionClient carries authenticated inbound context. Inventory independently
// enforces role, permission and resource scope at every application entrypoint.
type CollectionClient interface {
	Issue(context.Context, IssueRequest) ([]OpeningChest, error)
	GrantStarter(context.Context, string, []Grant) error
	Chests(context.Context, string) ([]OpeningChest, error)
	Claim(context.Context, string, string, string) (Claimed, error)
	Open(context.Context, string, string, string) (OpeningChest, error)
	MergeChests(context.Context, PairRequest) (OpeningChest, error)
	MergeItems(context.Context, PairRequest) (Item, error)
	MergeOdds(context.Context, string, string, string) (MergeOdds, error)
	Items(context.Context, string) ([]Item, error)
}
