// Package rulebookjson reads the human-edited rulebook file (server/config/economy.json) into the
// domain rulebook. Unknown fields are errors, so a misspelt key cannot be silently ignored.
package rulebookjson

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/voxel-vault/api/internal/inventory/domain/rulebook"
)

type file struct {
	Revision    string           `json:"revision"`
	Rarities    []string         `json:"rarities"`
	Severities  []string         `json:"severities"`
	Parts       []string         `json:"parts"`
	Tiers       []float64        `json:"tiers"`
	Events      []event          `json:"events"`
	Collections []collection     `json:"collections"`
	Types       []chestType      `json:"types"`
	Groups      []group          `json:"groups"`
	Traits      []trait          `json:"traits"`
	Params      map[string]param `json:"params"`
	Rules       []rule           `json:"rules"`
}

type event struct {
	ID   string    `json:"id"`
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
}

type collection struct {
	ID       string `json:"id"`
	Material string `json:"material"`
}

type chestType struct {
	ID         string `json:"id"`
	Collection string `json:"collection"`
	Pool       []item `json:"pool"`
}

type item struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Rarity string `json:"rarity"`
	Glyph  string `json:"glyph"`
}

type group struct {
	ID    string `json:"id"`
	Merge string `json:"merge"`
}

type trait struct {
	ID             string    `json:"id"`
	Group          string    `json:"group"`
	Parts          []string  `json:"parts"`
	Condition      float64   `json:"condition"`
	Tiers          []float64 `json:"tiers,omitempty"`
	Exclusive      string    `json:"exclusive,omitempty"`
	BonusMinRarity string    `json:"bonusMinRarity,omitempty"`
}

type param struct {
	Default float64  `json:"default"`
	Min     *float64 `json:"min,omitempty"`
	Max     *float64 `json:"max,omitempty"`
	Integer bool     `json:"integer,omitempty"`
}

type rule struct {
	ID       string               `json:"id"`
	When     map[string]condition `json:"when"`
	Priority int                  `json:"priority,omitempty"`
	Set      map[string]float64   `json:"set,omitempty"`
	Multiply map[string]float64   `json:"multiply,omitempty"`
	Add      map[string]float64   `json:"add,omitempty"`
}

// condition is a bare value (equality, or membership for a list field) or an object of in, lt,
// lte, gt, gte.
type condition rulebook.Condition

func (c *condition) UnmarshalJSON(data []byte) error {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	if _, isObject := value.(map[string]any); !isObject {
		if value == nil {
			return fmt.Errorf("condition must not be null")
		}
		c.Eq = value
		return nil
	}
	var parsed struct {
		In  []any    `json:"in"`
		Lt  *float64 `json:"lt"`
		Lte *float64 `json:"lte"`
		Gt  *float64 `json:"gt"`
		Gte *float64 `json:"gte"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&parsed); err != nil {
		return err
	}
	*c = condition{In: parsed.In, Lt: parsed.Lt, Lte: parsed.Lte, Gt: parsed.Gt, Gte: parsed.Gte}
	return nil
}

func Load(path string) (*rulebook.Rulebook, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read rulebook: %w", err)
	}
	return Parse(data)
}

// Parse reads and validates a rulebook; an invalid one is rejected whole.
func Parse(data []byte) (*rulebook.Rulebook, error) {
	var f file
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&f); err != nil {
		return nil, fmt.Errorf("rulebook file: %w", err)
	}
	return rulebook.New(f.definition())
}

func (f file) definition() rulebook.Definition {
	def := rulebook.Definition{
		Revision: f.Revision, Rarities: f.Rarities, Severities: f.Severities, Parts: f.Parts, Tiers: f.Tiers,
		Params: map[string]rulebook.Param{},
	}
	for _, e := range f.Events {
		def.Events = append(def.Events, rulebook.Event{ID: e.ID, From: e.From, To: e.To})
	}
	for _, c := range f.Collections {
		def.Collections = append(def.Collections, rulebook.Collection{ID: c.ID, Material: c.Material})
	}
	for _, t := range f.Types {
		chest := rulebook.ChestType{ID: t.ID, Collection: t.Collection}
		for _, i := range t.Pool {
			chest.Pool = append(chest.Pool, rulebook.Item{ID: i.ID, Title: i.Title, Rarity: i.Rarity, Glyph: i.Glyph})
		}
		def.Types = append(def.Types, chest)
	}
	for _, g := range f.Groups {
		def.Groups = append(def.Groups, rulebook.Group{ID: g.ID, Merge: g.Merge})
	}
	for _, t := range f.Traits {
		def.Traits = append(def.Traits, rulebook.TraitDef{ID: t.ID, Group: t.Group, Parts: t.Parts, Condition: t.Condition,
			Tiers: t.Tiers, Exclusive: t.Exclusive, BonusMinRarity: t.BonusMinRarity})
	}
	for key, p := range f.Params {
		def.Params[key] = rulebook.Param{Default: p.Default, Min: p.Min, Max: p.Max, Integer: p.Integer}
	}
	for _, r := range f.Rules {
		when := map[string]rulebook.Condition{}
		for field, c := range r.When {
			when[field] = rulebook.Condition(c)
		}
		def.Rules = append(def.Rules, rulebook.Rule{ID: r.ID, When: when, Priority: r.Priority, Set: r.Set, Multiply: r.Multiply, Add: r.Add})
	}
	return def
}
