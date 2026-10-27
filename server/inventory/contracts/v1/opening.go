package v1

import "context"

type OpeningItem struct {
	ID         string `json:"id"`
	Owner      string `json:"owner"`
	Definition string `json:"definition"`
	Condition  string `json:"condition"`
	Origin     string `json:"origin"`
}
type Opening struct {
	Source string        `json:"source"`
	Digest string        `json:"digest"`
	Items  []OpeningItem `json:"items"`
}

// OpeningClient is a trusted offline administration port, not a player API.
type OpeningClient interface {
	ImportItems(context.Context, Opening) error
}

type Error struct {
	Code string `json:"code"`
}

func (e *Error) Error() string { return "inventory: " + e.Code }

const (
	Invalid     = "invalid"
	Conflict    = "conflict"
	Unavailable = "unavailable"
	NotFound    = "not_found"
	Forbidden   = "forbidden"
)
