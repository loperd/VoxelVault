package v1

import (
	"context"
	"time"
)

type Recipient struct {
	ID          string `json:"id"`
	Handle      string `json:"handle"`
	DisplayName string `json:"displayName"`
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
type Quote struct {
	ID            string       `json:"id"`
	Recipient     Recipient    `json:"recipient"`
	CurrencyID    string       `json:"currencyId"`
	Code          string       `json:"code"`
	Precision     uint8        `json:"precision"`
	OriginalUnits string       `json:"originalUnits"`
	DebitUnits    string       `json:"debitUnits"`
	ReceiptUnits  string       `json:"receiptUnits"`
	Commission    []Commission `json:"commission"`
	RuleVersion   string       `json:"ruleVersion"`
	ExpiresAt     time.Time    `json:"expiresAt"`
}
type TransferReceipt struct {
	TransferID   string `json:"transferId"`
	JournalID    string `json:"journalId"`
	CurrencyID   string `json:"currencyId"`
	State        string `json:"state"`
	DebitUnits   string `json:"debitUnits"`
	ReceiptUnits string `json:"receiptUnits"`
}
type TransferClient interface {
	ResolveRecipient(context.Context, string, string) (Recipient, error)
	QuoteTransfer(context.Context, string, string, string) (Quote, error)
	ConfirmTransfer(context.Context, string, string) (TransferReceipt, error)
}
