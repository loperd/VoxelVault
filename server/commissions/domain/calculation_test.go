package domain

import (
	"math"
	"testing"
)

func TestIndependentFeeRoundingAndAllocation(t *testing.T) {
	rule := Rule{
		ID:          "tax",
		Version:     "1",
		GeneralTax:  true,
		Imposition:  Inside,
		Numerator:   1,
		Denominator: 100,
		Destination: []Destination{
			{Account: "treasury", Weight: 10},
			{Account: "special", Weight: 70},
			{Burn: true, Weight: 20},
		},
	}
	for _, tc := range []struct {
		name    string
		amount  int64
		want    int64
		invalid bool
	}{{"below minimum", 49, 0, true}, {"half up", 50, 1, false}, {"one unit", 100, 1, false}, {"half up again", 150, 2, false}} {
		t.Run(tc.name, func(t *testing.T) {
			plan, err := Calculate(tc.amount, []Rule{rule})
			if tc.invalid {
				if err == nil {
					t.Fatal("zero tax accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if plan.Commission[0].Units != tc.want {
				t.Fatal(plan)
			}
			var sum int64
			for _, leg := range plan.Commission[0].Allocation {
				sum += leg.Units
			}
			if sum != tc.want {
				t.Fatal("allocation lost money", plan)
			}
			if tc.want == 1 &&
				(len(plan.Commission[0].Allocation) != 1 || plan.Commission[0].Allocation[0].Account != "special") {
				t.Fatal(plan)
			}
		})
	}
	other := rule
	other.ID = "extra"
	other.GeneralTax = false
	other.Imposition = Outside
	plan, err := Calculate(10000, []Rule{rule, other})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Debit != 10100 || plan.Receipt != 9900 || plan.Commission[0].Units != 100 ||
		plan.Commission[1].Units != 100 {
		t.Fatal(plan)
	}
}

func TestInvalidPlanAndOverflow(t *testing.T) {
	rule := Rule{
		ID:          "tax",
		Version:     "1",
		GeneralTax:  true,
		Imposition:  Outside,
		Numerator:   1,
		Denominator: 2,
		Destination: []Destination{{Account: "a", Weight: 1}, {Account: "b", Weight: 1}},
	}
	plan, err := Calculate(2, []Rule{rule})
	if err != nil || plan.Commission[0].Allocation[0].Account != "a" {
		t.Fatal(plan, err)
	}
	if _, err = Calculate(math.MaxInt64, []Rule{rule}); err == nil {
		t.Fatal("overflow accepted")
	}
	for _, mutate := range []func(*Rule){func(r *Rule) { r.Imposition = "unknown" }, func(r *Rule) { r.Denominator = 0 }, func(r *Rule) { r.Numerator = -1 }, func(r *Rule) { r.Destination = nil }, func(r *Rule) { r.Destination[0].Weight = 0 }} {
		r := rule
		r.Destination = append([]Destination(nil), rule.Destination...)
		mutate(&r)
		if _, err := Calculate(100, []Rule{r}); err == nil {
			t.Fatal("invalid rule accepted", r)
		}
	}
}
