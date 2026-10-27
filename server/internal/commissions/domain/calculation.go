package domain

import (
	"errors"
	"math"
	"math/big"
	"sort"
)

var ErrInvalid = errors.New("invalid commission plan")

const (
	Inside  = "inside"
	Outside = "outside"
)

type Destination struct {
	Account string
	Burn    bool
	Weight  int64
}
type Rule struct {
	ID, Version, Currency, Imposition string
	GeneralTax                        bool
	Numerator, Denominator            int64
	Destination                       []Destination
}
type Allocation struct {
	Account string
	Burn    bool
	Units   int64
}
type Commission struct {
	RuleID, Version, Imposition string
	Units                       int64
	Allocation                  []Allocation
}
type Plan struct {
	Debit, Receipt int64
	Commission     []Commission
}

func (r Rule) Validate() error {
	if r.ID == "" || r.Version == "" || (r.Imposition != Inside && r.Imposition != Outside) ||
		r.Numerator <= 0 ||
		r.Denominator <= 0 ||
		r.Numerator > r.Denominator ||
		len(r.Destination) == 0 ||
		len(r.Destination) > 100 {
		return ErrInvalid
	}
	seen := map[string]bool{}
	total := new(big.Int)
	for _, d := range r.Destination {
		key := d.Account
		if d.Burn {
			key = "burn"
		}
		if d.Weight <= 0 || d.Burn && d.Account != "" || !d.Burn && d.Account == "" || seen[key] {
			return ErrInvalid
		}
		seen[key] = true
		total.Add(total, big.NewInt(d.Weight))
	}
	if !total.IsInt64() {
		return ErrInvalid
	}
	return nil
}

func Calculate(amount int64, rules []Rule) (Plan, error) {
	p := Plan{Debit: amount, Receipt: amount, Commission: []Commission{}}
	if amount <= 0 || len(rules) == 0 || len(rules) > 100 {
		return p, ErrInvalid
	}
	general := false
	seen := map[string]bool{}
	for _, r := range rules {
		if err := r.Validate(); err != nil {
			return p, err
		}
		if seen[r.ID] {
			return p, ErrInvalid
		}
		seen[r.ID] = true
		n := new(big.Int).Mul(big.NewInt(amount), big.NewInt(r.Numerator))
		q, rem := new(big.Int), new(big.Int)
		q.QuoRem(n, big.NewInt(r.Denominator), rem)
		if rem.Lsh(rem, 1).Cmp(big.NewInt(r.Denominator)) >= 0 {
			q.Add(q, big.NewInt(1))
		}
		if !q.IsInt64() {
			return p, ErrInvalid
		}
		units := q.Int64()
		if r.GeneralTax {
			if general || units == 0 {
				return p, ErrInvalid
			}
			general = true
		}
		if r.Imposition == Inside {
			if units >= p.Receipt {
				return p, ErrInvalid
			}
			p.Receipt -= units
		} else {
			if units > math.MaxInt64-p.Debit {
				return p, ErrInvalid
			}
			p.Debit += units
		}
		c := Commission{
			RuleID:     r.ID,
			Version:    r.Version,
			Imposition: r.Imposition,
			Units:      units,
			Allocation: []Allocation{},
		}
		total := int64(0)
		for _, d := range r.Destination {
			total += d.Weight
		}
		type share struct {
			destination Destination
			units       int64
			remainder   *big.Int
			key         string
		}
		shares := []share{}
		allocated := int64(0)
		for _, d := range r.Destination {
			numerator := new(big.Int).Mul(big.NewInt(units), big.NewInt(d.Weight))
			base, remainder := new(big.Int), new(big.Int)
			base.QuoRem(numerator, big.NewInt(total), remainder)
			key := d.Account
			if d.Burn {
				key = "~burn"
			}
			shares = append(shares, share{d, base.Int64(), remainder, key})
			allocated += base.Int64()
		}
		sort.Slice(shares, func(i, j int) bool {
			cmp := shares[i].remainder.Cmp(shares[j].remainder)
			if cmp == 0 {
				return shares[i].key < shares[j].key
			}
			return cmp > 0
		})
		for i := int64(0); i < units-allocated; i++ {
			shares[i].units++
		}
		for _, s := range shares {
			if s.units > 0 {
				c.Allocation = append(
					c.Allocation,
					Allocation{s.destination.Account, s.destination.Burn, s.units},
				)
			}
		}
		p.Commission = append(p.Commission, c)
	}
	if !general {
		return p, ErrInvalid
	}
	return p, nil
}
