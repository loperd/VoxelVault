// Package v1 is Wallet's published language. It exposes scalar DTOs, never domain,
// repository, SQL or other bounded-context types. A client is bound to an authenticated
// producer by its transport adapter; producer identity is not a command body field.
package v1

import "context"

type Terms struct {
	Subject  string `json:"subject"`
	Asset    string `json:"asset"`
	Units    string `json:"units"`
	Purpose  string `json:"purpose"`
	Evidence string `json:"evidence"`
	Treasury string `json:"treasury,omitempty"`
}
type Command struct {
	ID       string `json:"commandId"`
	IntentID string `json:"intentId"`
	Action   string `json:"action"`
	Terms    *Terms `json:"terms,omitempty"`
}
type Receipt struct {
	IntentID  string `json:"intentId"`
	State     string `json:"state"`
	Version   uint64 `json:"version"`
	Terms     *Terms `json:"terms,omitempty"`
	JournalID string `json:"journalId,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Kind      string `json:"kind,omitempty"`
}
type Balance struct {
	Posted    string `json:"posted"`
	Held      string `json:"held"`
	Available string `json:"available"`
}
type Event struct {
	Version       int     `json:"contractVersion"`
	ID            string  `json:"messageId"`
	CorrelationID string  `json:"correlationId"`
	CausationID   string  `json:"causationId,omitempty"`
	Producer      string  `json:"producer"`
	Receipt       Receipt `json:"receipt"`
}
type Client interface {
	Execute(context.Context, Command) (Receipt, error)
	Status(context.Context, string) (Receipt, error)
	Balance(context.Context, string, string) (Balance, error)
}
type EventSink interface {
	Deliver(context.Context, Event) error
}
type Error struct {
	Code string `json:"code"`
}

func (e *Error) Error() string { return "wallet: " + e.Code }

const (
	Invalid     = "invalid"
	Conflict    = "conflict"
	Forbidden   = "forbidden"
	NotReady    = "not_ready"
	Unavailable = "unavailable"
	RateLimited = "rate_limited"
)
