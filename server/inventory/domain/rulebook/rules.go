package rulebook

import (
	"fmt"
	"math"
	"slices"
)

// Rule changes params in the situations it matches. All matching rules apply: the most specific
// "set" (most conditions, then the higher priority, then the later rule) replaces the default,
// every "multiply" multiplies it and every "add" adds to it; the result is clamped to the param's
// bounds.
type Rule struct {
	ID       string
	When     map[string]Condition
	Priority int
	Set      map[string]float64
	Multiply map[string]float64
	Add      map[string]float64
}

// Condition tests one situation field: Eq is equality (or, for a list field such as events,
// membership), In any of the values, Lt…Gte bounds of a number.
type Condition struct {
	Eq               any
	In               []any
	Lt, Lte, Gt, Gte *float64
}

// Situation is everything a rule can look at. Fields are strings, numbers or string lists:
//
//	type, collection, source (starter, admin, event-reward, purchase), origin (issued, merged)
//	events, time.weekday (0 = Sunday), time.hour
//	player.segments, player.opens, player.opensSinceRare
//	chest.rarity, chest.condition, chest.traits
//	item.rarity, item.state
type Situation map[string]any

// With is a copy of the situation with some fields set, so a caller's situation is never changed.
func (s Situation) With(fields Situation) Situation {
	merged := make(Situation, len(s)+len(fields))
	for k, v := range s {
		merged[k] = v
	}
	for k, v := range fields {
		merged[k] = v
	}
	return merged
}

var situationFields = map[string]string{
	"type": "string", "collection": "string", "source": "string", "origin": "string",
	"events": "list", "time.weekday": "number", "time.hour": "number",
	"player.segments": "list", "player.opens": "number", "player.opensSinceRare": "number",
	"chest.rarity": "string", "chest.condition": "number", "chest.traits": "list",
	"item.rarity": "string", "item.state": "string",
}

func (r *Rulebook) validateRules() []error {
	var errs []error
	ids := map[string]bool{}
	for _, rule := range r.def.Rules {
		if rule.ID == "" || ids[rule.ID] {
			errs = append(errs, fmt.Errorf("rule %q: id must be set and unique", rule.ID))
		}
		ids[rule.ID] = true
		if len(rule.Set)+len(rule.Multiply)+len(rule.Add) == 0 {
			errs = append(errs, fmt.Errorf("rule %q changes nothing", rule.ID))
		}
		for field, cond := range rule.When {
			kind, ok := situationFields[field]
			if !ok {
				errs = append(errs, fmt.Errorf("rule %q: unknown situation field %q", rule.ID, field))
				continue
			}
			numeric := cond.Lt != nil || cond.Lte != nil || cond.Gt != nil || cond.Gte != nil
			if numeric && kind != "number" {
				errs = append(errs, fmt.Errorf("rule %q: %q is not a number", rule.ID, field))
			}
			if cond.Eq == nil && cond.In == nil && !numeric {
				errs = append(errs, fmt.Errorf("rule %q: empty condition on %q", rule.ID, field))
			}
		}
		for _, changes := range []map[string]float64{rule.Set, rule.Multiply, rule.Add} {
			for key := range changes {
				if !r.ruleTargetsDeclared(key) {
					errs = append(errs, fmt.Errorf("rule %q: param %q is not declared", rule.ID, key))
				}
			}
		}
	}
	return errs
}

// A rule may target a concrete key or a pattern; either way it must reach a declared param.
func (r *Rulebook) ruleTargetsDeclared(key string) bool {
	if _, ok := r.declaration(key); ok {
		return true
	}
	for declared := range r.def.Params {
		if keyMatches(key, declared) {
			return true
		}
	}
	return false
}

func (r Rule) matches(s Situation) bool {
	for field, cond := range r.When {
		if !cond.matches(s[field]) {
			return false
		}
	}
	return true
}

func (c Condition) matches(value any) bool {
	if value == nil {
		return false
	}
	if list, ok := value.([]string); ok {
		if c.Eq != nil {
			return slices.Contains(list, fmt.Sprint(c.Eq))
		}
		for _, want := range c.In {
			if slices.Contains(list, fmt.Sprint(want)) {
				return true
			}
		}
		return false
	}
	if number, ok := toNumber(value); ok {
		switch {
		case c.Lt != nil && !(number < *c.Lt), c.Lte != nil && !(number <= *c.Lte),
			c.Gt != nil && !(number > *c.Gt), c.Gte != nil && !(number >= *c.Gte):
			return false
		}
		if c.Eq != nil {
			want, ok := toNumber(c.Eq)
			return ok && want == number
		}
		if c.In != nil {
			return slices.ContainsFunc(c.In, func(v any) bool { want, ok := toNumber(v); return ok && want == number })
		}
		return true
	}
	text := fmt.Sprint(value)
	if c.Eq != nil {
		return fmt.Sprint(c.Eq) == text
	}
	return slices.ContainsFunc(c.In, func(v any) bool { return fmt.Sprint(v) == text })
}

func toNumber(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	}
	return 0, false
}

// Value resolves a param in a situation. Asking for an undeclared key is a programming error the
// validation should have caught, so it panics.
func (r *Rulebook) Value(key string, s Situation) float64 {
	param, ok := r.declaration(key)
	if !ok {
		panic(fmt.Sprintf("rulebook: param %q is not declared", key))
	}
	value, setBy := param.Default, -1
	best := Rule{}
	multiply, add := 1.0, 0.0
	for i, rule := range r.def.Rules {
		if !rule.matches(s) {
			continue
		}
		if v, ok := lookup(rule.Set, key); ok && (setBy < 0 || moreSpecific(rule, best)) {
			value, setBy, best = v, i, rule
		}
		if v, ok := lookup(rule.Multiply, key); ok {
			multiply *= v
		}
		if v, ok := lookup(rule.Add, key); ok {
			add += v
		}
	}
	return param.clamp(value*multiply + add)
}

// lookup finds the change a rule makes to a key, by the key itself or by a pattern covering it.
func lookup(changes map[string]float64, key string) (float64, bool) {
	if v, ok := changes[key]; ok {
		return v, true
	}
	best, found := "", false
	for pattern := range changes {
		if keyMatches(pattern, key) && (!found || morePrecise(pattern, best)) {
			best, found = pattern, true
		}
	}
	return changes[best], found
}

// moreSpecific: rules are visited in file order, so a tie goes to the later one.
func moreSpecific(candidate, current Rule) bool {
	if len(candidate.When) != len(current.When) {
		return len(candidate.When) > len(current.When)
	}
	return candidate.Priority >= current.Priority
}

func (p Param) clamp(value float64) float64 {
	if p.Integer {
		value = math.Round(value)
	}
	if p.Min != nil {
		value = math.Max(value, *p.Min)
	}
	if p.Max != nil {
		value = math.Min(value, *p.Max)
	}
	return value
}
