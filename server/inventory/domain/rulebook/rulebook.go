// Package rulebook is the reference data and policy every other domain module reads: rarities,
// collections, chest types with their pools, the trait registry, and the params with the rules
// that change them by situation (docs/reference/economy.md). A human edits it; the code only
// knows its shape. A Rulebook is immutable once built and identified by its revision.
package rulebook

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

// Group merge modes: a merge drops the traits of a "reset" group and lets those of a "keep" group
// survive by the merge.<group>.* chances.
const (
	MergeReset = "reset"
	MergeKeep  = "keep"
)

// Intact is the state of an undamaged item; the damaged ones are the severities, mildest first.
const Intact = "intact"

type Definition struct {
	Revision string
	// Rarities and Severities are ordered: lowest rarity first, mildest severity first.
	Rarities    []string
	Severities  []string
	Parts       []string
	Tiers       []float64
	Events      []Event
	Collections []Collection
	Types       []ChestType
	Groups      []Group
	Traits      []TraitDef
	Params      map[string]Param
	Rules       []Rule
}

type Event struct {
	ID       string
	From, To time.Time
}

type Collection struct {
	ID       string
	Material string
}

type ChestType struct {
	ID         string
	Collection string
	Pool       []Item
}

type Item struct {
	ID     string
	Title  string
	Rarity string
	Glyph  string
}

type Group struct {
	ID    string
	Merge string
}

type TraitDef struct {
	ID    string
	Group string
	Parts []string
	// Condition is how much of the trait's intensity wears the parts it covers (0 — none).
	Condition float64
	// Tiers override the global tier thresholds for this trait.
	Tiers []float64
	// Traits sharing an exclusive key never sit on one chest together (snow and frost).
	Exclusive string
	// BonusMinRarity is the lowest rarity of the items the trait brings into the contents, when
	// trait.<id>.bonusSlotsPerTier gives it any; empty means any rarity.
	BonusMinRarity string
}

// Param is a declared number: rules may only target declared keys, and the result is clamped to
// [Min, Max]. A key segment "*" declares a default for every key of that shape; an exact
// declaration wins over a pattern.
type Param struct {
	Default float64
	Min     *float64
	Max     *float64
	Integer bool
}

type Rulebook struct {
	def         Definition
	types       map[string]*ChestType
	collections map[string]*Collection
	groups      map[string]*Group
	traits      map[string]*TraitDef
	itemType    map[string]*ChestType
	rarityRank  map[string]int
	stateRank   map[string]int
}

// New validates a definition and builds a rulebook from it; an invalid definition is rejected
// whole, with every problem listed.
func New(def Definition) (*Rulebook, error) {
	r := &Rulebook{def: def}
	if err := r.index(); err != nil {
		return nil, fmt.Errorf("rulebook %s: %w", def.Revision, err)
	}
	return r, nil
}

func (r *Rulebook) index() error {
	var errs []error
	fail := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }
	def := &r.def
	if def.Revision == "" {
		fail("revision is empty")
	}
	if len(def.Rarities) == 0 {
		fail("no rarities")
	}
	r.rarityRank = ranks(def.Rarities, fail, "rarity")
	r.stateRank = ranks(append([]string{Intact}, def.Severities...), fail, "item state")
	if err := ascendingTiers(def.Tiers); err != nil {
		fail("tiers: %v", err)
	}
	for _, event := range def.Events {
		if event.ID == "" || !event.To.After(event.From) {
			fail("event %q needs an id and to after from", event.ID)
		}
	}
	r.collections = map[string]*Collection{}
	for i := range def.Collections {
		collection := &def.Collections[i]
		if collection.Material == "" {
			fail("collection %q has no material", collection.ID)
		}
		r.collections[collection.ID] = collection
	}
	r.types, r.itemType = map[string]*ChestType{}, map[string]*ChestType{}
	for i := range def.Types {
		chest := &def.Types[i]
		if _, ok := r.types[chest.ID]; ok || chest.ID == "" {
			fail("type %q: id must be set and unique", chest.ID)
		}
		if _, ok := r.collections[chest.Collection]; !ok {
			fail("type %q: unknown collection %q", chest.ID, chest.Collection)
		}
		if len(chest.Pool) == 0 {
			fail("type %q has an empty pool", chest.ID)
		}
		for _, item := range chest.Pool {
			if _, ok := r.itemType[item.ID]; ok || item.ID == "" {
				fail("item %q: id must be set and unique", item.ID)
			}
			r.itemType[item.ID] = chest
			if _, ok := r.rarityRank[item.Rarity]; !ok {
				fail("item %q: unknown rarity %q", item.ID, item.Rarity)
			}
		}
		r.types[chest.ID] = chest
	}
	r.groups = map[string]*Group{}
	for i := range def.Groups {
		group := &def.Groups[i]
		if group.Merge != MergeReset && group.Merge != MergeKeep {
			fail("group %q: merge must be %s or %s", group.ID, MergeReset, MergeKeep)
		}
		r.groups[group.ID] = group
	}
	r.traits = map[string]*TraitDef{}
	for i := range def.Traits {
		trait := &def.Traits[i]
		if _, ok := r.traits[trait.ID]; ok || trait.ID == "" {
			fail("trait %q: id must be set and unique", trait.ID)
		}
		if _, ok := r.groups[trait.Group]; !ok {
			fail("trait %q: unknown group %q", trait.ID, trait.Group)
		}
		for _, part := range trait.Parts {
			if !slices.Contains(def.Parts, part) {
				fail("trait %q: unknown part %q", trait.ID, part)
			}
		}
		if trait.Condition < 0 || trait.Condition > 1 {
			fail("trait %q: condition must be within [0, 1]", trait.ID)
		}
		if trait.Tiers != nil {
			if err := ascendingTiers(trait.Tiers); err != nil {
				fail("trait %q tiers: %v", trait.ID, err)
			}
		}
		if _, ok := r.rarityRank[trait.BonusMinRarity]; trait.BonusMinRarity != "" && !ok {
			fail("trait %q: unknown bonus rarity %q", trait.ID, trait.BonusMinRarity)
		}
		r.traits[trait.ID] = trait
	}
	for key, param := range def.Params {
		if param.Min != nil && param.Max != nil && *param.Min > *param.Max {
			fail("param %q: min above max", key)
		}
	}
	// Every key the domain reads must be declared, so a typo in the data cannot silently fall back.
	for _, key := range r.requiredKeys() {
		if _, ok := r.declaration(key); !ok {
			fail("param %q is not declared", key)
		}
	}
	errs = append(errs, r.validateRules()...)
	return errors.Join(errs...)
}

func ranks(ordered []string, fail func(string, ...any), what string) map[string]int {
	rank := map[string]int{}
	for i, id := range ordered {
		if _, ok := rank[id]; ok || id == "" {
			fail("%s %q: id must be set and unique", what, id)
		}
		rank[id] = i
	}
	return rank
}

func ascendingTiers(tiers []float64) error {
	if len(tiers) == 0 {
		return errors.New("empty")
	}
	for i, tier := range tiers {
		if tier <= 0 || tier > 1 || (i > 0 && tier <= tiers[i-1]) {
			return errors.New("must ascend within (0, 1]")
		}
	}
	return nil
}

func (r *Rulebook) requiredKeys() []string {
	keys := []string{
		"content.size", "rarity.threshold", "trait.intensity.bias",
		"landing.damage.chance", "landing.damage.intensity.max",
		"chest.destroy.impact.perWear", "chest.destroy.opening.perWear",
		"item.damage.perWear", "item.merge.repair", "item.sellRate", "item.state." + Intact + ".value",
	}
	for _, rarity := range r.def.Rarities {
		keys = append(keys, "pool.weight."+rarity, "item.value."+rarity)
	}
	for _, severity := range r.def.Severities {
		keys = append(keys, "item.severity."+severity+".base", "item.severity."+severity+".perWear", "item.state."+severity+".value")
	}
	for _, group := range r.def.Groups {
		keys = append(keys, "trait.group."+group.ID+".chance", "trait.group."+group.ID+".count.min", "trait.group."+group.ID+".count.max")
		if group.Merge == MergeKeep {
			keys = append(keys, "merge."+group.ID+".keepOne", "merge."+group.ID+".keepBoth", "merge."+group.ID+".upgrade")
		}
	}
	for _, trait := range r.def.Traits {
		keys = append(keys, "trait."+trait.ID+".weight", "trait."+trait.ID+".bonusSlotsPerTier")
	}
	return keys
}

// declaration finds the param that governs a concrete key: the exact one, else a "*" pattern.
func (r *Rulebook) declaration(key string) (Param, bool) {
	if param, ok := r.def.Params[key]; ok {
		return param, true
	}
	best, found := "", false
	for pattern := range r.def.Params {
		if keyMatches(pattern, key) && (!found || morePrecise(pattern, best)) {
			best, found = pattern, true
		}
	}
	return r.def.Params[best], found
}

// morePrecise prefers fewer "*" segments, then the lexically smaller key, so the choice is stable.
func morePrecise(a, b string) bool {
	if sa, sb := strings.Count(a, "*"), strings.Count(b, "*"); sa != sb {
		return sa < sb
	}
	return a < b
}

// keyMatches compares dot-separated keys; "*" stands for exactly one segment.
func keyMatches(pattern, key string) bool {
	p, k := strings.Split(pattern, "."), strings.Split(key, ".")
	if len(p) != len(k) {
		return false
	}
	for i := range p {
		if p[i] != "*" && p[i] != k[i] {
			return false
		}
	}
	return true
}

func (r *Rulebook) Revision() string     { return r.def.Revision }
func (r *Rulebook) Parts() []string      { return r.def.Parts }
func (r *Rulebook) Groups() []Group      { return r.def.Groups }
func (r *Rulebook) Severities() []string { return r.def.Severities }

// Types are the chest types in the order the rulebook lists them.
func (r *Rulebook) Types() []*ChestType {
	types := make([]*ChestType, len(r.def.Types))
	for i := range r.def.Types {
		types[i] = r.types[r.def.Types[i].ID]
	}
	return types
}

func (r *Rulebook) Type(id string) (*ChestType, bool) {
	chest, ok := r.types[id]
	return chest, ok
}

func (r *Rulebook) Group(id string) (*Group, bool) {
	group, ok := r.groups[id]
	return group, ok
}

func (r *Rulebook) Trait(id string) (*TraitDef, bool) {
	trait, ok := r.traits[id]
	return trait, ok
}

// TraitsOf lists a group's traits in registry order.
func (r *Rulebook) TraitsOf(group string) []*TraitDef {
	var traits []*TraitDef
	for i := range r.def.Traits {
		if r.def.Traits[i].Group == group {
			traits = append(traits, &r.def.Traits[i])
		}
	}
	return traits
}

// Item finds a pool item and the chest type whose pool holds it.
func (r *Rulebook) Item(id string) (Item, *ChestType, bool) {
	chest, ok := r.itemType[id]
	if !ok {
		return Item{}, nil, false
	}
	for _, item := range chest.Pool {
		if item.ID == id {
			return item, chest, true
		}
	}
	return Item{}, nil, false
}

// Material is the resource of the collection a chest type belongs to.
func (r *Rulebook) Material(chest *ChestType) string { return r.collections[chest.Collection].Material }

// ActiveEvents lists the events running at a moment, for the "events" situation field.
func (r *Rulebook) ActiveEvents(now time.Time) []string {
	var active []string
	for _, event := range r.def.Events {
		if !now.Before(event.From) && now.Before(event.To) {
			active = append(active, event.ID)
		}
	}
	return active
}

// RarityRank orders rarities from 0 (lowest); an unknown one ranks below all.
func (r *Rulebook) RarityRank(rarity string) int {
	if rank, ok := r.rarityRank[rarity]; ok {
		return rank
	}
	return -1
}

// Rarities are ordered from the lowest.
func (r *Rulebook) Rarities() []string { return r.def.Rarities }

// StateRank orders item states from 0 (intact) to the worst severity; an unknown one is -1.
func (r *Rulebook) StateRank(state string) int {
	if rank, ok := r.stateRank[state]; ok {
		return rank
	}
	return -1
}

// States lists item states from intact to the worst severity.
func (r *Rulebook) States() []string { return append([]string{Intact}, r.def.Severities...) }

// TierThresholds are the intensities at which a trait reaches tier 1, 2, …
func (r *Rulebook) TierThresholds(traitID string) []float64 {
	if trait, ok := r.traits[traitID]; ok && trait.Tiers != nil {
		return trait.Tiers
	}
	return r.def.Tiers
}

// Tier is the step a trait's intensity has reached: 0 below the first threshold, then 1, 2, …
func (r *Rulebook) Tier(traitID string, intensity float64) int {
	tier := 0
	for _, threshold := range r.TierThresholds(traitID) {
		if intensity >= threshold {
			tier++
		}
	}
	return tier
}
