package application

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"time"

	"github.com/voxel-vault/api/inventory/domain"
	"github.com/voxel-vault/api/inventory/domain/chest"
	"github.com/voxel-vault/api/inventory/domain/rulebook"
)

const MaxIssue = 100

type Grant struct {
	Type  string
	Count int
}
type IssueRequest struct {
	Owner, RequestID, Type, Source string
	Count                          int
}
type PairRequest struct{ Owner, RequestID, A, B string }
type CollectionResult struct {
	Chests []domain.StoredChest
	Item   *domain.Item
}
type CollectionTx interface {
	LockOwner(string) (*time.Time, error)
	MarkStarter(string, time.Time) error
	ClaimCollection(string, string, string) (*CollectionResult, error)
	CompleteCollection(string, CollectionResult) error
	Chest(string, string) (domain.StoredChest, error)
	Chests(string) ([]domain.StoredChest, error)
	SaveChest(domain.StoredChest) error
	ReceiveItem(domain.Item) error
	LockItem(string, string) (domain.Item, error)
	SaveCollectionItem(domain.Item) error
}
type CollectionStore interface {
	Collection(context.Context, func(CollectionTx) error) error
	Items(context.Context, string) ([]domain.Item, error)
}
type CollectionService struct {
	Store         CollectionStore
	Rulebook      func() *rulebook.Rulebook
	Clock         func() time.Time
	Seed          func() (uint64, error)
	Authorizer    Authorizer
	StarterPolicy func([]Grant) bool
}

func (s CollectionService) ready() error {
	if s.Store == nil || s.Rulebook == nil || s.Clock == nil || s.Seed == nil {
		return domain.ErrInvalid
	}
	return nil
}

func (s CollectionService) Items(ctx context.Context, owner string) ([]domain.Item, error) {
	var authorizationErr error
	ctx, authorizationErr = authorize(ctx, s.Authorizer, ReadItems, Resource{Kind: "owner", ID: owner, Owner: owner})
	if authorizationErr != nil {
		return nil, authorizationErr
	}
	if err := s.ready(); err != nil {
		return nil, err
	}
	if !domain.ValidID(owner) {
		return nil, domain.ErrInvalid
	}
	items, err := s.Store.Items(ctx, owner)
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		if item.Owner != owner {
			return nil, ErrForbidden
		}
	}
	return items, nil
}
func (s CollectionService) situation(rb *rulebook.Rulebook) rulebook.Situation {
	now := s.Clock().UTC()
	return rulebook.Situation{"events": rb.ActiveEvents(now), "time.weekday": int(now.Weekday()), "time.hour": now.Hour()}
}
func (s CollectionService) issue(tx CollectionTx, rb *rulebook.Rulebook, owner, command, kind, source string, count int) ([]domain.StoredChest, error) {
	if !domain.ValidID(kind) || !domain.ValidID(source) || count < 1 || count > MaxIssue {
		return nil, domain.ErrInvalid
	}
	var result []domain.StoredChest
	for i := range count {
		seed, err := s.Seed()
		if err != nil {
			return nil, err
		}
		id := domain.Identity("chest", command, strconv.Itoa(i))
		c, err := chest.Issue(rb, chest.IssueRequest{ID: id, Owner: owner, Type: kind, Source: source, Seed: seed, Situation: s.situation(rb)})
		if err != nil {
			return nil, err
		}
		record := domain.StoredChest{State: c.State(), CreatedAt: s.Clock().UTC()}
		if err = tx.SaveChest(record); err != nil {
			return nil, err
		}
		result = append(result, record)
	}
	return result, nil
}
func (s CollectionService) Issue(ctx context.Context, r IssueRequest) ([]domain.StoredChest, error) {
	var authorizationErr error
	ctx, authorizationErr = authorize(ctx, s.Authorizer, IssueChests, Resource{Kind: "owner", ID: r.Owner, Owner: r.Owner, Source: r.Source})
	if authorizationErr != nil {
		return nil, authorizationErr
	}
	if err := s.ready(); err != nil {
		return nil, err
	}
	if !domain.ValidID(r.Owner) || !domain.ValidID(r.RequestID) || !domain.ValidID(r.Type) || !domain.ValidID(r.Source) || r.Count < 1 || r.Count > MaxIssue {
		return nil, domain.ErrInvalid
	}
	var result CollectionResult
	err := s.command(ctx, r.Owner, r.RequestID, "issue", r, func(tx CollectionTx) (CollectionResult, error) {
		cs, err := s.issue(tx, s.Rulebook(), r.Owner, domain.Identity("issue", r.Owner, r.RequestID), r.Type, r.Source, r.Count)
		return CollectionResult{Chests: cs}, err
	}, &result)
	return result.Chests, err
}
func (s CollectionService) command(ctx context.Context, owner, request, action string, input any, fn func(CollectionTx) (CollectionResult, error), result *CollectionResult) error {
	if !domain.ValidID(owner) || !domain.ValidID(request) {
		return domain.ErrInvalid
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return err
	}
	id := domain.Identity("collection-command", owner, request)
	ctx = withLifecycle(ctx, action, id, input)
	return s.Store.Collection(ctx, func(tx CollectionTx) error {
		if _, err := tx.LockOwner(owner); err != nil {
			return err
		}
		prior, err := tx.ClaimCollection(id, owner, domain.Identity(action, string(raw)))
		if err != nil {
			return err
		}
		if prior != nil {
			*result = *prior
			return nil
		}
		r, err := fn(tx)
		if err != nil {
			return err
		}
		if err = tx.CompleteCollection(id, r); err != nil {
			return err
		}
		*result = r
		return nil
	})
}
func (s CollectionService) GrantStarter(ctx context.Context, owner string, grants []Grant) error {
	var authorizationErr error
	ctx, authorizationErr = authorize(ctx, s.Authorizer, GrantStarter, Resource{Kind: "owner", ID: owner, Owner: owner, Source: "starter"})
	if authorizationErr != nil {
		return authorizationErr
	}
	if s.StarterPolicy == nil || !s.StarterPolicy(grants) {
		return ErrForbidden
	}
	if err := s.ready(); err != nil {
		return err
	}
	if !domain.ValidID(owner) {
		return domain.ErrInvalid
	}
	total := 0
	for _, g := range grants {
		if !domain.ValidID(g.Type) || g.Count < 1 || g.Count > MaxIssue {
			return domain.ErrInvalid
		}
		total += g.Count
	}
	if total > MaxIssue {
		return domain.ErrInvalid
	}
	ctx = withLifecycle(ctx, "starter_grant", domain.Identity("starter", owner), map[string]any{"owner": owner, "grants": grants})
	return s.Store.Collection(ctx, func(tx CollectionTx) error {
		at, err := tx.LockOwner(owner)
		if err != nil || at != nil {
			return err
		}
		rb := s.Rulebook()
		for i, g := range grants {
			if _, err = s.issue(tx, rb, owner, domain.Identity("starter", owner, strconv.Itoa(i)), g.Type, "starter", g.Count); err != nil {
				return err
			}
		}
		return tx.MarkStarter(owner, s.Clock().UTC())
	})
}
func (s CollectionService) current(tx CollectionTx, rb *rulebook.Rulebook, r domain.StoredChest) (domain.StoredChest, error) {
	if !r.State.Legacy() {
		return r, nil
	}
	c, err := chest.Reissue(rb, r.State, s.situation(rb))
	if err != nil {
		return r, err
	}
	r.State = c.State()
	// Historical openings are already paid out. Missing old items may have been sold;
	// metadata reconstruction must never mint their rewards a second time.
	return r, tx.SaveChest(r)
}
func (s CollectionService) Chests(ctx context.Context, owner string) ([]domain.StoredChest, error) {
	var authorizationErr error
	ctx, authorizationErr = authorize(ctx, s.Authorizer, ReadChests, Resource{Kind: "owner", ID: owner, Owner: owner})
	if authorizationErr != nil {
		return nil, authorizationErr
	}
	if err := s.ready(); err != nil {
		return nil, err
	}
	if !domain.ValidID(owner) {
		return nil, domain.ErrInvalid
	}
	ctx = withLifecycle(ctx, "metadata_refresh", domain.Identity("metadata", owner, s.Rulebook().Revision()), map[string]string{"owner": owner})
	var result []domain.StoredChest
	err := s.Store.Collection(ctx, func(tx CollectionTx) error {
		if _, err := tx.LockOwner(owner); err != nil {
			return err
		}
		cs, err := tx.Chests(owner)
		if err != nil {
			return err
		}
		rb := s.Rulebook()
		for _, c := range cs {
			if c.State.Owner != owner {
				return ErrForbidden
			}
			c, err = s.current(tx, rb, c)
			if err != nil {
				return err
			}
			result = append(result, c)
		}
		return nil
	})
	return result, err
}
func (s CollectionService) Claim(ctx context.Context, owner, id, session string) (domain.StoredChest, *chest.Landing, error) {
	var authorizationErr error
	ctx, authorizationErr = authorize(ctx, s.Authorizer, ClaimChest, Resource{Kind: "chest", ID: id, Owner: owner})
	if authorizationErr != nil {
		return domain.StoredChest{}, nil, authorizationErr
	}
	if err := s.ready(); err != nil {
		return domain.StoredChest{}, nil, err
	}
	if !domain.ValidID(owner) || !domain.ValidID(id) || !domain.ValidID(session) {
		return domain.StoredChest{}, nil, domain.ErrInvalid
	}
	ctx = withLifecycle(ctx, "chest_claim", domain.Identity("claim", id, session), map[string]string{"owner": owner, "chest": id, "session": session})
	var result domain.StoredChest
	var landing *chest.Landing
	err := s.Store.Collection(ctx, func(tx CollectionTx) error {
		if _, err := tx.LockOwner(owner); err != nil {
			return err
		}
		r, err := tx.Chest(owner, id)
		if err != nil {
			return err
		}
		if r.State.Owner != owner || r.State.ID != id {
			return domain.ErrNotFound
		}
		rb := s.Rulebook()
		r, err = s.current(tx, rb, r)
		if err != nil {
			return err
		}
		if r.State.Session == session && r.State.Status != chest.Available {
			result = r
			return nil
		}
		c := chest.Restore(r.State)
		l, err := c.Claim(rb, s.situation(rb), session)
		if err != nil {
			return err
		}
		r.State = c.State()
		if err = tx.SaveChest(r); err != nil {
			return err
		}
		result = r
		landing = &l
		return nil
	})
	return result, landing, err
}
func (s CollectionService) Open(ctx context.Context, owner, id, session string) (domain.StoredChest, error) {
	var authorizationErr error
	ctx, authorizationErr = authorize(ctx, s.Authorizer, OpenChest, Resource{Kind: "chest", ID: id, Owner: owner})
	if authorizationErr != nil {
		return domain.StoredChest{}, authorizationErr
	}
	if err := s.ready(); err != nil {
		return domain.StoredChest{}, err
	}
	if !domain.ValidID(owner) || !domain.ValidID(id) || !domain.ValidID(session) {
		return domain.StoredChest{}, domain.ErrInvalid
	}
	ctx = withLifecycle(ctx, "chest_open", domain.Identity("open", id, session), map[string]string{"owner": owner, "chest": id, "session": session})
	var result domain.StoredChest
	err := s.Store.Collection(ctx, func(tx CollectionTx) error {
		if _, err := tx.LockOwner(owner); err != nil {
			return err
		}
		r, err := tx.Chest(owner, id)
		if err != nil {
			return err
		}
		if r.State.Owner != owner || r.State.ID != id {
			return domain.ErrNotFound
		}
		rb := s.Rulebook()
		r, err = s.current(tx, rb, r)
		if err != nil {
			return err
		}
		if r.State.Session == session && (r.State.Status == chest.Opened || r.State.Status == chest.Destroyed) {
			result = r
			return nil
		}
		c := chest.Restore(r.State)
		out, err := c.Open(rb, s.situation(rb), session)
		if err != nil {
			return err
		}
		r.State = c.State()
		if out.Drop != nil {
			if _, _, ok := rb.Item(out.Drop.Item); !ok {
				return domain.ErrNotFound
			}
			item := domain.Item{ID: domain.Identity("drop", id), Owner: owner, Definition: out.Drop.Item, Condition: out.Drop.State, Origin: id, Status: domain.Available}
			if err = domain.ValidateOpeningItem(item); err != nil {
				return err
			}
			if err = tx.ReceiveItem(item); err != nil {
				return err
			}
			r.Reward = &item
			at := s.Clock().UTC()
			r.OpenedAt = &at
		}
		if err = tx.SaveChest(r); err != nil {
			return err
		}
		result = r
		return nil
	})
	return result, err
}
func validPair(r PairRequest) bool {
	return domain.ValidID(r.Owner) && domain.ValidID(r.RequestID) && domain.ValidID(r.A) && domain.ValidID(r.B) && r.A != r.B
}
func (s CollectionService) MergeChests(ctx context.Context, r PairRequest) (domain.StoredChest, error) {
	var authorizationErr error
	for _, id := range []string{r.A, r.B} {
		ctx, authorizationErr = authorize(ctx, s.Authorizer, MergeChests, Resource{Kind: "chest", ID: id, Owner: r.Owner})
		if authorizationErr != nil {
			return domain.StoredChest{}, authorizationErr
		}
	}
	if err := s.ready(); err != nil {
		return domain.StoredChest{}, err
	}
	if !validPair(r) {
		return domain.StoredChest{}, domain.ErrInvalid
	}
	var result CollectionResult
	err := s.command(ctx, r.Owner, r.RequestID, "merge-chests", r, func(tx CollectionTx) (CollectionResult, error) {
		a, err := tx.Chest(r.Owner, r.A)
		if err != nil {
			return CollectionResult{}, err
		}
		if a.State.Owner != r.Owner || a.State.ID != r.A {
			return CollectionResult{}, domain.ErrNotFound
		}
		b, err := tx.Chest(r.Owner, r.B)
		if err != nil {
			return CollectionResult{}, err
		}
		if b.State.Owner != r.Owner || b.State.ID != r.B {
			return CollectionResult{}, domain.ErrNotFound
		}
		rb := s.Rulebook()
		a, err = s.current(tx, rb, a)
		if err != nil {
			return CollectionResult{}, err
		}
		b, err = s.current(tx, rb, b)
		if err != nil {
			return CollectionResult{}, err
		}
		ca, cb := chest.Restore(a.State), chest.Restore(b.State)
		seed, err := s.Seed()
		if err != nil {
			return CollectionResult{}, err
		}
		merged, err := chest.Merge(rb, ca, cb, chest.MergeRequest{ID: domain.Identity("merged-chest", r.Owner, r.RequestID), Seed: seed, Situation: s.situation(rb)})
		if err != nil {
			return CollectionResult{}, err
		}
		a.State, b.State = ca.State(), cb.State()
		c := domain.StoredChest{State: merged.State(), CreatedAt: s.Clock().UTC()}
		for _, record := range []domain.StoredChest{a, b, c} {
			if err = tx.SaveChest(record); err != nil {
				return CollectionResult{}, err
			}
		}
		return CollectionResult{Chests: []domain.StoredChest{c}}, nil
	}, &result)
	if err != nil {
		return domain.StoredChest{}, err
	}
	return result.Chests[0], nil
}
func (s CollectionService) MergeOdds(ctx context.Context, owner, a, b string) (chest.MergeOdds, error) {
	var authorizationErr error
	for _, id := range []string{a, b} {
		ctx, authorizationErr = authorize(ctx, s.Authorizer, ReadMergeOdds, Resource{Kind: "chest", ID: id, Owner: owner})
		if authorizationErr != nil {
			return chest.MergeOdds{}, authorizationErr
		}
	}
	if err := s.ready(); err != nil {
		return chest.MergeOdds{}, err
	}
	if !domain.ValidID(owner) || !domain.ValidID(a) || !domain.ValidID(b) || a == b {
		return chest.MergeOdds{}, domain.ErrInvalid
	}
	ctx = withLifecycle(ctx, "metadata_refresh", domain.Identity("odds", owner, a, b), map[string]string{"owner": owner, "a": a, "b": b})
	var odds chest.MergeOdds
	err := s.Store.Collection(ctx, func(tx CollectionTx) error {
		if _, err := tx.LockOwner(owner); err != nil {
			return err
		}
		ca, err := tx.Chest(owner, a)
		if err != nil {
			return err
		}
		if ca.State.Owner != owner || ca.State.ID != a {
			return domain.ErrNotFound
		}
		cb, err := tx.Chest(owner, b)
		if err != nil {
			return err
		}
		if cb.State.Owner != owner || cb.State.ID != b {
			return domain.ErrNotFound
		}
		rb := s.Rulebook()
		ca, err = s.current(tx, rb, ca)
		if err != nil {
			return err
		}
		cb, err = s.current(tx, rb, cb)
		if err != nil {
			return err
		}
		odds, err = chest.Odds(rb, chest.Restore(ca.State), chest.Restore(cb.State), s.situation(rb))
		return err
	})
	return odds, err
}
func (s CollectionService) MergeItems(ctx context.Context, r PairRequest) (domain.Item, error) {
	var authorizationErr error
	for _, id := range []string{r.A, r.B} {
		ctx, authorizationErr = authorize(ctx, s.Authorizer, MergeItems, Resource{Kind: "item", ID: id, Owner: r.Owner})
		if authorizationErr != nil {
			return domain.Item{}, authorizationErr
		}
	}
	if err := s.ready(); err != nil {
		return domain.Item{}, err
	}
	if !validPair(r) {
		return domain.Item{}, domain.ErrInvalid
	}
	var result CollectionResult
	err := s.command(ctx, r.Owner, r.RequestID, "merge-items", r, func(tx CollectionTx) (CollectionResult, error) {
		ids := []string{r.A, r.B}
		sort.Strings(ids)
		items := map[string]domain.Item{}
		for _, id := range ids {
			item, err := tx.LockItem(id, r.Owner)
			if err != nil {
				return CollectionResult{}, err
			}
			if item.ID != id || item.Owner != r.Owner {
				return CollectionResult{}, domain.ErrNotFound
			}
			items[id] = item
		}
		seed, err := s.Seed()
		if err != nil {
			return CollectionResult{}, err
		}
		rb := s.Rulebook()
		kept, gone, err := domain.MergeItems(rb, items[r.A], items[r.B], seed, s.situation(rb))
		if err != nil {
			return CollectionResult{}, err
		}
		for _, item := range []domain.Item{kept, gone} {
			if err = tx.SaveCollectionItem(item); err != nil {
				return CollectionResult{}, err
			}
		}
		return CollectionResult{Item: &kept}, nil
	}, &result)
	if err != nil {
		return domain.Item{}, err
	}
	return *result.Item, nil
}
