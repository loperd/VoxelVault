package v1

import "context"

type AssetBalance struct {
	Asset     string `json:"asset"`
	Posted    string `json:"posted"`
	Held      string `json:"held"`
	Available string `json:"available"`
}
type HistoryEntry struct {
	ID        string `json:"id"`
	Asset     string `json:"asset"`
	Direction string `json:"direction"`
	Units     string `json:"units"`
	Purpose   string `json:"purpose"`
	Reference string `json:"reference"`
	Status    string `json:"status"`
	At        string `json:"at,omitempty"`
}
type History struct {
	Entries []HistoryEntry `json:"entries"`
	Next    string         `json:"nextCursor,omitempty"`
}
type ReadClient interface {
	Balances(context.Context, string) ([]AssetBalance, error)
	History(context.Context, string, string, string, int) (History, error)
}
type Baseline struct {
	Source, Digest string
	Complete       bool
}
type BaselineReader interface {
	Baseline(context.Context) (Baseline, error)
}
