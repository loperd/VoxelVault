package v1

import "context"

type Issue struct {
	UserID, UserAgent, IP string
	TTLSeconds            int64
}
type Issued struct{ SessionID, RefreshJTI string }
type Refreshed struct{ UserID, RefreshJTI string }
type Sessions interface {
	Issue(context.Context, Issue) (Issued, error)
	Refresh(context.Context, string, string) (Refreshed, error)
	Revoke(context.Context, string) error
	Validate(context.Context, string, string) error
}
type Error struct{ Code string }

func (e *Error) Error() string { return "identity: " + e.Code }
