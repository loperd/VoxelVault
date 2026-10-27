package application

import (
	"context"
	"strings"

	"github.com/voxel-vault/api/internal/identity/domain"
)

type (
	Profile       struct{ ID, Handle, DisplayName string }
	ProfileReader interface {
		Profile(context.Context, string) (Profile, error)
	}
)

type RecipientLookup struct{ Identifier, OpaqueHandleID string }
type RecipientReader interface {
	RecipientCandidates(context.Context, RecipientLookup) ([]Profile, error)
}

func (a Accounts) ResolveRecipient(ctx context.Context, query string) (Profile, error) {
	// An opaque handle is "u_" plus an account id, so it may be 2 bytes longer than an id.
	validQuery := domain.ValidID(query) || (strings.HasPrefix(query, "u_") && domain.ValidID(strings.TrimPrefix(query, "u_")))
	if !validQuery || !domain.SafeProfileText(query, 162) || a.Recipient == nil {
		return Profile{}, domain.ErrInvalid
	}
	if _, err := a.access(ctx, "identity.profile.read", "account", query); err != nil {
		return Profile{}, err
	}

	// Telegram-derived handles are private legacy metadata, never public lookup keys.
	if domain.LegacyTelegramHandle(query) {
		return Profile{}, ErrConflict
	}
	lookup := RecipientLookup{Identifier: query}
	if strings.HasPrefix(query, "u_") {
		lookup.OpaqueHandleID = strings.TrimPrefix(query, "u_")
	}
	candidates, err := a.Recipient.RecipientCandidates(ctx, lookup)
	if err != nil {
		return Profile{}, err
	}
	var match Profile
	count := 0
	for _, p := range candidates {
		legacy := domain.LegacyTelegramHandle(p.Handle)
		if p.ID == query || !legacy && p.Handle == query || legacy && "u_"+p.ID == query {
			match = p
			count++
		}
	}
	if count != 1 {
		return Profile{}, ErrConflict
	}
	return publicProfile(match)
}

func (a Accounts) Profile(ctx context.Context, id string) (Profile, error) {
	if !domain.ValidID(id) {
		return Profile{}, domain.ErrInvalid
	}
	if _, err := a.access(ctx, "identity.profile.read", "account", id); err != nil {
		return Profile{}, err
	}
	reader := a.Profiles
	if reader == nil {
		return Profile{}, domain.ErrInvalid
	}
	p, err := reader.Profile(ctx, id)
	if err != nil {
		return Profile{}, err
	}
	return publicProfile(p)
}

func publicProfile(p Profile) (Profile, error) {
	if domain.LegacyTelegramHandle(p.Handle) {
		p.Handle = "u_" + p.ID
	}
	if !validProfile(p) {
		return Profile{}, domain.ErrInvalid
	}
	return p, nil
}

func validProfile(p Profile) bool {
	return domain.ValidID(p.ID) && p.Handle != "" && strings.TrimSpace(p.Handle) == p.Handle &&
		domain.SafeProfileText(p.Handle, 162) && p.DisplayName != "" && domain.SafeProfileText(p.DisplayName, 160)
}

func (a Accounts) Exists(ctx context.Context, id string) (bool, error) {
	if !domain.ValidID(id) {
		return false, domain.ErrInvalid
	}
	if _, err := a.access(ctx, "identity.profile.read", "account", id); err != nil {
		return false, err
	}
	return a.Registry.Exists(ctx, id)
}
