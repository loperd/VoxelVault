package chest

import (
	"math"

	"github.com/voxel-vault/api/inventory/domain/dice"
	"github.com/voxel-vault/api/inventory/domain/rulebook"
)

// Landing is what the fall did to a chest: the damage trait it added or strengthened, if any,
// and whether the impact destroyed it.
type Landing struct {
	Damage    *Trait
	Destroyed bool
}

// Claim starts an opening session: the chest falls, and the server — not the client — decides
// what the landing did. A chest the impact destroyed ends without a drop.
func (c *Chest) Claim(rb *rulebook.Rulebook, base rulebook.Situation, session string) (Landing, error) {
	if session == "" {
		return Landing{}, ErrNoSession
	}
	if c.s.Status != Available {
		return Landing{}, ErrUnavailable
	}
	d := dice.New(c.s.Seed, dice.StreamLanding)
	s := c.situation(rb, base)
	var landing Landing
	if d.Chance(rb.Value("landing.damage.chance", s)) {
		landing.Damage = c.strike(rb, s, d)
		if landing.Damage != nil {
			// The landing changed the chest itself, so its condition is refrozen by today's rules.
			c.s.Condition = Condition(rb, c.s.Traits)
			s = c.situation(rb, base)
		}
	}
	c.s.Session = session
	c.s.Status = Opening
	if d.Chance((1 - c.s.Condition) * rb.Value("chest.destroy.impact.perWear", s)) {
		c.destroy(AtImpact)
		landing.Destroyed = true
	}
	return landing, nil
}

// strike adds a landing.trait.<id>.weight trait, or strengthens it if the chest has it already.
func (c *Chest) strike(rb *rulebook.Rulebook, s rulebook.Situation, d *dice.Dice) *Trait {
	var candidates []*rulebook.TraitDef
	var weights []float64
	for _, group := range rb.Groups() {
		for _, def := range rb.TraitsOf(group.ID) {
			if c.excluded(rb, def) {
				continue
			}
			candidates = append(candidates, def)
			weights = append(weights, rb.Value("landing.trait."+def.ID+".weight", s))
		}
	}
	pick := d.Weighted(weights)
	if pick < 0 {
		return nil
	}
	added := (1 - d.Float()) * rb.Value("landing.damage.intensity.max", s)
	for i := range c.s.Traits {
		if c.s.Traits[i].ID == candidates[pick].ID {
			c.s.Traits[i].Intensity = math.Min(1, c.s.Traits[i].Intensity+added)
			trait := c.s.Traits[i]
			return &trait
		}
	}
	trait := Trait{ID: candidates[pick].ID, Intensity: added, Seed: d.Uint32()}
	if trait.Intensity <= 0 {
		return nil
	}
	c.s.Traits = append(c.s.Traits, trait)
	return &trait
}

func (c *Chest) excluded(rb *rulebook.Rulebook, def *rulebook.TraitDef) bool {
	for _, trait := range c.s.Traits {
		if excludes(rb, trait.ID, def) {
			return true
		}
	}
	return false
}

// Outcome of an opening: a drop, or the overload destroyed the chest.
type Outcome struct {
	Drop      *Drop
	Destroyed bool
}

// Open finishes the session: the worn chest may give way under the opening overload; otherwise
// one item of its own contents drops by weight, damaged with a chance that grows with the wear.
// The contents are the frozen ones; the chances come from the rulebook in force now.
func (c *Chest) Open(rb *rulebook.Rulebook, base rulebook.Situation, session string) (Outcome, error) {
	if c.s.Status != Opening {
		return Outcome{}, ErrNotOpening
	}
	if c.s.Session != session {
		return Outcome{}, ErrWrongSession
	}
	if len(c.s.Contents) == 0 {
		return Outcome{}, ErrEmpty
	}
	d := dice.New(c.s.Seed, dice.StreamOpening)
	s := c.situation(rb, base)
	wear := 1 - c.s.Condition
	if d.Chance(wear * rb.Value("chest.destroy.opening.perWear", s)) {
		c.destroy(AtOpening)
		return Outcome{Destroyed: true}, nil
	}
	weights := make([]float64, len(c.s.Contents))
	for i, slot := range c.s.Contents {
		weights[i] = slot.Weight
	}
	pick := d.Weighted(weights)
	if pick < 0 {
		pick = d.Index(len(c.s.Contents))
	}
	drop := Drop{Item: c.s.Contents[pick].Item, State: rulebook.Intact}
	item, _, _ := rb.Item(drop.Item)
	s = s.With(rulebook.Situation{"item.rarity": item.Rarity})
	if d.Chance(wear * rb.Value("item.damage.perWear", s)) {
		drop.State = severity(rb, s, wear, d)
	}
	c.s.Drop = &drop
	c.s.Status = Opened
	return Outcome{Drop: &drop}, nil
}

// severity weighs each severity as base + perWear × wear (negative counts as 0).
func severity(rb *rulebook.Rulebook, s rulebook.Situation, wear float64, d *dice.Dice) string {
	severities := rb.Severities()
	weights := make([]float64, len(severities))
	for i, sev := range severities {
		key := "item.severity." + sev
		weights[i] = math.Max(0, rb.Value(key+".base", s)+rb.Value(key+".perWear", s)*wear)
	}
	if pick := d.Weighted(weights); pick >= 0 {
		return severities[pick]
	}
	return severities[0]
}

func (c *Chest) destroy(moment Moment) {
	c.s.Status = Destroyed
	c.s.DestroyedAt = moment
}
