// Package dice is the domain's only source of chance: a deterministic generator from a seed, so
// every issue, landing, opening and merge can be replayed from the seed the server stored.
package dice

import (
	"math"
	"math/rand/v2"
)

// Streams keep the decisions of one seed independent: adding a draw to the landing does not
// shift what the opening rolls.
const (
	StreamIssue uint64 = iota + 1
	StreamLanding
	StreamOpening
	StreamMerge
	StreamItemMerge
)

type Dice struct{ rng *rand.Rand }

func New(seed, stream uint64) *Dice { return &Dice{rng: rand.New(rand.NewPCG(seed, stream))} }

// Float is uniform in [0, 1).
func (d *Dice) Float() float64 { return d.rng.Float64() }

// Chance is true with probability p.
func (d *Dice) Chance(p float64) bool { return d.rng.Float64() < p }

// Between is uniform in [lo, hi]; hi below lo yields lo.
func (d *Dice) Between(lo, hi int) int {
	if hi <= lo {
		return lo
	}
	return lo + d.rng.IntN(hi-lo+1)
}

func (d *Dice) Uint32() uint32 { return d.rng.Uint32() }

func (d *Dice) Index(n int) int { return d.rng.IntN(n) }

// Weighted picks an index by weight; -1 when no weight is positive.
func (d *Dice) Weighted(weights []float64) int {
	total := 0.0
	for _, w := range weights {
		if w > 0 {
			total += w
		}
	}
	if total <= 0 {
		return -1
	}
	roll := d.rng.Float64() * total
	last := -1
	for i, w := range weights {
		if w <= 0 {
			continue
		}
		last = i
		if roll < w {
			return i
		}
		roll -= w
	}
	return last
}

// Weak is an intensity in (0, 1] leaning towards weak: bias 1 is uniform, 2 gives a mean of 1/3.
func (d *Dice) Weak(bias float64) float64 { return math.Pow(1-d.rng.Float64(), bias) }
