package application

import "context"

// Principal is established by a trusted inbound boundary, never by command fields.
type Principal struct{ Kind, ID string }
type principalKey struct{}

func WithAuthenticatedPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

func AuthenticatedPrincipal(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok && p.Kind == "user" && p.ID != ""
}
