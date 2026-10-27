package v1

import "context"

// OpeningClient is an offline migration capability, never part of the player client.
type OpeningBalance struct {
	Subject string `json:"subject"`
	Asset   string `json:"asset"`
	Units   string `json:"units"`
}
type Opening struct {
	Source   string           `json:"source"`
	Digest   string           `json:"digest"`
	At       string           `json:"at"`
	Balances []OpeningBalance `json:"balances"`
}
type OpeningClient interface {
	ImportOpening(context.Context, Opening) error
}
