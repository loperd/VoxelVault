package v1

import "context"

type Error struct{ Code string }

func (e *Error) Error() string { return "commission: " + e.Code }

type TransferFact struct {
	CurrencyID, SenderID, RecipientID, OriginalUnits string
	Precision                                        uint8
}
type Allocation struct {
	AccountRef string `json:"accountRef,omitempty"`
	Burn       bool   `json:"burn,omitempty"`
	Units      string `json:"units"`
}
type Commission struct {
	RuleID     string       `json:"ruleId"`
	Version    string       `json:"version"`
	Imposition string       `json:"imposition"`
	Units      string       `json:"units"`
	Allocation []Allocation `json:"allocation"`
}
type Plan struct {
	Version      string       `json:"version"`
	DebitUnits   string       `json:"debitUnits"`
	ReceiptUnits string       `json:"receiptUnits"`
	Commission   []Commission `json:"commission"`
}
type Calculator interface {
	CalculateTransfer(context.Context, TransferFact) (Plan, error)
}
