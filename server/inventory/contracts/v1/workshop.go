package v1

import "context"

type Amount struct {
	Asset string `json:"asset"`
	Units string `json:"units"`
}
type Operation struct {
	ID      string `json:"operationId"`
	ItemID  string `json:"itemId"`
	Action  string `json:"action"`
	Stage   string `json:"stage"`
	Version uint64 `json:"version"`
	Quote   Amount `json:"quote"`
	Reason  string `json:"reason,omitempty"`
}
type Offers struct {
	Repair      *Amount `json:"repair"`
	Salvage     Amount  `json:"salvage"`
	Sell        Amount  `json:"sell"`
	MergeWith   string  `json:"mergeWith,omitempty"`
	MergeRepair float64 `json:"mergeRepair"`
}
type PricedItem struct {
	Item   Item    `json:"item"`
	Offers *Offers `json:"offers"`
}
type WorkshopClient interface {
	Start(context.Context, string, string, string, string) (Operation, error)
	Status(context.Context, string, string) (Operation, error)
	Cancel(context.Context, string, string) (Operation, error)
	Items(context.Context, string) ([]PricedItem, error)
}
type Baseline struct {
	Source, Digest string
	Complete       bool
}
type BaselineReader interface {
	Baseline(context.Context) (Baseline, error)
}
