package v1

import "context"

type ProviderIdentity struct{ Provider, ExternalID, Username, DisplayName string }
type LinkRequest struct {
	UserID, SessionID string
	Scopes            []string
	Identity          ProviderIdentity
}
type Accounts interface {
	Resolve(context.Context, ProviderIdentity) (string, error)
	Link(context.Context, LinkRequest) (string, error)
	Permissions(context.Context, string) ([]string, error)
	Catalog(context.Context) ([]string, error)
}

// Profiles is a separate published read capability, bound to a trusted service.
type Profile struct{ ID, Handle, DisplayName string }
type Profiles interface {
	Profile(context.Context, string) (Profile, error)
	Exists(context.Context, string) (bool, error)
}

type RecipientResolver interface {
	ResolveRecipient(context.Context, string) (Profile, error)
}
