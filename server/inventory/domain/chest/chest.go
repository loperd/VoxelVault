// Package chest is the chest aggregate: what a chest holds (contents, traits), what it is worth
// (rarity, condition, frozen when it changes), and its life — issued or merged, claimed for a
// session and landed, opened into a drop or destroyed, or merged into another chest.
package chest

import (
	"errors"
	"slices"

	"github.com/voxel-vault/api/inventory/domain/rulebook"
)

type Status string

const (
	Available Status = "available"
	Opening   Status = "opening"
	Opened    Status = "opened"
	Destroyed Status = "destroyed"
	Merged    Status = "merged"
)

// Moment is when a chest was destroyed: by the impact of its landing or by the opening overload.
type Moment string

const (
	AtImpact  Moment = "impact"
	AtOpening Moment = "opening"
)

const SourceMerge = "merge"

var (
	ErrUnavailable  = errors.New("chest is not available")
	ErrNotOpening   = errors.New("chest is not being opened")
	ErrWrongSession = errors.New("chest is claimed by another session")
	ErrNoSession    = errors.New("session is required")
	ErrEmpty        = errors.New("chest type yields no contents")
	ErrUnknownType  = errors.New("unknown chest type")
	ErrMismatch     = errors.New("only two different chests of one owner and one type merge")
)

// Trait is one trait of a chest: Intensity in (0, 1], Seed drives how it is drawn.
type Trait struct {
	ID        string
	Intensity float64
	Seed      uint32
}

// Slot is one item of a chest's contents with its weight in the roll.
type Slot struct {
	Item   string
	Weight float64
}

// Origin is how a chest came to be: issued by a source (starter, admin, …) or merged from parents.
type Origin struct {
	Source  string
	Parents []string
}

func (o Origin) kind() string {
	if o.Source == SourceMerge {
		return "merged"
	}
	return "issued"
}

// Drop is the item an opening yielded and the state it fell in.
type Drop struct {
	Item  string
	State string
}

// State is everything a chest is; repositories store it and Restore brings it back.
type State struct {
	ID, Owner, Type string
	// Revision is the rulebook that set the contents, rarity and condition.
	Revision    string
	Seed        uint64
	Contents    []Slot
	Traits      []Trait
	Rarity      string
	Condition   float64
	Origin      Origin
	Status      Status
	Session     string
	Drop        *Drop
	DestroyedAt Moment
}

type Chest struct{ s State }

// Restore brings back a stored chest.
func Restore(s State) *Chest { return &Chest{s: s.clone()} }

// State is a copy, so a caller cannot change the chest behind its methods.
func (c *Chest) State() State { return c.s.clone() }

func (s State) clone() State {
	s.Contents = slices.Clone(s.Contents)
	s.Traits = slices.Clone(s.Traits)
	s.Origin.Parents = slices.Clone(s.Origin.Parents)
	if s.Drop != nil {
		drop := *s.Drop
		s.Drop = &drop
	}
	return s
}

// situation is what the rules see of this chest, on top of the caller's (time, events, player).
func (c *Chest) situation(rb *rulebook.Rulebook, base rulebook.Situation) rulebook.Situation {
	traits := make([]string, len(c.s.Traits))
	for i, trait := range c.s.Traits {
		traits[i] = trait.ID
	}
	return base.With(rulebook.Situation{
		"type": c.s.Type, "collection": collectionOf(rb, c.s.Type), "source": c.s.Origin.Source,
		"origin": c.s.Origin.kind(), "chest.rarity": c.s.Rarity, "chest.condition": c.s.Condition,
		"chest.traits": traits,
	})
}

func collectionOf(rb *rulebook.Rulebook, typeID string) string {
	if chestType, ok := rb.Type(typeID); ok {
		return chestType.Collection
	}
	return ""
}

// appraise refreezes rarity and condition from the contents and traits by the given rulebook.
func (c *Chest) appraise(rb *rulebook.Rulebook, s rulebook.Situation) {
	c.s.Rarity = Rarity(rb, c.s.Contents, rb.Value("rarity.threshold", s))
	c.s.Condition = Condition(rb, c.s.Traits)
}
