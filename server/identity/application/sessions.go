package application

import (
	"context"
	"time"
	"unicode/utf8"

	"github.com/voxel-vault/api/identity/domain"
)

type Principal struct{ Kind, ID string }
type principalKey struct{}

func WithAuthenticatedPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

type Access struct {
	Principal                                   Principal
	Permission, ResourceKind, ResourceID, Owner string
}
type Decision struct{ PolicyVersion string }
type Authorizer interface {
	Authorize(context.Context, Access) (Decision, error)
}
type Directory interface {
	Exists(context.Context, string) (bool, error)
}
type Cause struct{ Actor, PolicyVersion string }
type Event struct {
	SessionID, Kind string
	At              time.Time
	Cause           Cause
}
type Store interface {
	Create(context.Context, domain.Session, Event) error
	Read(context.Context, string) (domain.Session, error)
	Transact(context.Context, string, func(Tx) error) error
}

type Tx interface {
	Session() domain.Session
	KnownToken(string) (bool, error)
	Save(domain.Session, string, time.Time, Event) error
}
type Issue struct {
	Subject, UserAgent, IP string
	TTLSeconds             int64
}
type Issued struct{ SessionID, RefreshToken string }
type Refreshed struct{ Subject, RefreshToken string }
type Service struct {
	Store      Store
	Directory  Directory
	Authorizer Authorizer
	Clock      func() time.Time
	ID         func() (string, error)
	Token      func() (string, error)
}

func (s Service) authorize(ctx context.Context, permission, kind, id, owner string) (Principal, Cause, error) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	if s.Store == nil || s.Directory == nil || s.Authorizer == nil || !ok || p.Kind != "service" || !domain.ValidID(p.ID) {
		return p, Cause{}, domain.ErrForbidden
	}
	d, err := s.Authorizer.Authorize(ctx, Access{Principal: p, Permission: permission, ResourceKind: kind, ResourceID: id, Owner: owner})
	if err != nil {
		return p, Cause{}, err
	}
	if !domain.ValidID(d.PolicyVersion) {
		return p, Cause{}, domain.ErrForbidden
	}
	return p, Cause{Actor: p.ID, PolicyVersion: d.PolicyVersion}, nil
}
func (s Service) now() (time.Time, error) {
	if s.Clock == nil {
		return time.Time{}, domain.ErrInvalid
	}
	now := s.Clock().UTC()
	if now.IsZero() {
		return now, domain.ErrInvalid
	}
	return now, nil
}
func (s Service) newToken() (string, string, error) {
	if s.Token == nil {
		return "", "", domain.ErrInvalid
	}
	token, err := s.Token()
	if err != nil {
		return "", "", err
	}
	hash, err := domain.HashToken(token)
	return token, hash, err
}
func (s Service) Issue(ctx context.Context, input Issue) (Issued, error) {
	var result Issued
	if !domain.ValidID(input.Subject) || input.TTLSeconds < 60 || input.TTLSeconds > 90*24*60*60 || !utf8.ValidString(input.UserAgent) || len(input.UserAgent) > 512 || !utf8.ValidString(input.IP) || len(input.IP) > 64 {
		return result, domain.ErrInvalid
	}
	p, cause, err := s.authorize(ctx, "identity.session.issue", "account", input.Subject, input.Subject)
	if err != nil {
		return result, err
	}
	exists, err := s.Directory.Exists(ctx, input.Subject)
	if err != nil {
		return result, err
	}
	if !exists {
		return result, domain.ErrUnauthenticated
	}
	now, err := s.now()
	if err != nil {
		return result, err
	}
	if s.ID == nil {
		return result, domain.ErrInvalid
	}
	id, err := s.ID()
	if err != nil {
		return result, err
	}
	if !domain.ValidID(id) {
		return result, domain.ErrInvalid
	}
	token, hash, err := s.newToken()
	if err != nil {
		return result, err
	}
	row := domain.Session{ID: id, Subject: input.Subject, Issuer: p.ID, CurrentHash: hash, CreatedAt: now, ExpiresAt: now.Add(time.Duration(input.TTLSeconds) * time.Second), UserAgent: input.UserAgent, IP: input.IP}
	if err = s.Store.Create(ctx, row, Event{SessionID: id, Kind: "issued", At: now, Cause: cause}); err != nil {
		return result, err
	}
	return Issued{SessionID: id, RefreshToken: token}, nil
}
func (s Service) Refresh(ctx context.Context, id, token string) (Refreshed, error) {
	var result Refreshed
	if !domain.ValidID(id) {
		return result, domain.ErrInvalid
	}
	presented, err := domain.HashToken(token)
	if err != nil {
		return result, domain.ErrUnauthenticated
	}
	p, cause, err := s.authorize(ctx, "identity.session.refresh", "session", id, "")
	if err != nil {
		return result, err
	}
	replacement, hash, err := s.newToken()
	if err != nil {
		return result, err
	}
	var denied error
	err = s.Store.Transact(ctx, id, func(tx Tx) error {
		now, err := s.now()
		if err != nil {
			return err
		}
		row := tx.Session()
		if row.Issuer != p.ID {
			return domain.ErrForbidden
		}
		known, err := tx.KnownToken(presented)
		if err != nil {
			return err
		}
		next, event, outcome := row.Rotate(presented, hash, known, now)
		if event != "" {
			if err := tx.Save(next, presented, now, Event{SessionID: id, Kind: event, At: now, Cause: cause}); err != nil {
				return err
			}
		}
		denied = outcome
		result = Refreshed{Subject: row.Subject, RefreshToken: replacement}
		return nil
	})
	if err != nil {
		return Refreshed{}, err
	}
	if denied != nil {
		return Refreshed{}, denied
	}
	return result, nil
}
func (s Service) Revoke(ctx context.Context, id string) error {
	if !domain.ValidID(id) {
		return domain.ErrInvalid
	}
	p, cause, err := s.authorize(ctx, "identity.session.revoke", "session", id, "")
	if err != nil {
		return err
	}
	return s.Store.Transact(ctx, id, func(tx Tx) error {
		now, err := s.now()
		if err != nil {
			return err
		}
		row := tx.Session()
		if row.Issuer != p.ID {
			return domain.ErrForbidden
		}
		if row.RevokedAt != nil {
			return nil
		}
		row.RevokedAt = &now
		return tx.Save(row, "", now, Event{SessionID: id, Kind: "revoked", At: now, Cause: cause})
	})
}

// Validate supplies a current session decision to gateway/backend adapters. It
// does not issue credentials and never trusts a subject inferred from a body alone.
func (s Service) Validate(ctx context.Context, id, subject string) error {
	if !domain.ValidID(id) || !domain.ValidID(subject) {
		return domain.ErrInvalid
	}
	p, _, err := s.authorize(ctx, "identity.session.validate", "session", id, subject)
	if err != nil {
		return err
	}
	row, err := s.Store.Read(ctx, id)
	if err != nil {
		return err
	}
	if row.ID != id {
		return domain.ErrInvalid
	}
	if row.Issuer != p.ID {
		return domain.ErrForbidden
	}
	if row.Subject != subject {
		return domain.ErrUnauthenticated
	}
	now, err := s.now()
	if err != nil {
		return err
	}
	if !row.Active(now) {
		return domain.ErrUnauthenticated
	}
	exists, err := s.Directory.Exists(ctx, subject)
	if err != nil {
		return err
	}
	if !exists {
		return domain.ErrUnauthenticated
	}
	return nil
}
