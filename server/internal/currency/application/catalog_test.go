package application

import (
	"context"
	"errors"
	"testing"
)

type authFunc func(context.Context, string) error

func (f authFunc) Authorize(c context.Context, p string) error { return f(c, p) }

type memberFunc func(context.Context, string, string) (bool, error)

func (f memberFunc) IsMember(c context.Context, u, g string) (bool, error) { return f(c, u, g) }
func TestAvailabilityIsNotRoleAndPrecisionIsExplicit(t *testing.T) {
	auth := authFunc(func(_ context.Context, p string) error {
		if p != "ledger" {
			return ErrForbidden
		}
		return nil
	})
	membership := memberFunc(
		func(_ context.Context, u, g string) (bool, error) { return u == "alice" && g == "testers", nil },
	)
	c, err := New(
		[]Definition{
			{
				Descriptor: Descriptor{
					ID:        "cent",
					Code:      "CENT",
					Name:      "Fractional",
					Precision: 2,
					Revision:  "1",
					Active:    true,
				},
				Group: []string{"testers"},
			},
		},
		auth,
		membership,
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		producer, user string
		allowed        bool
		forbidden      bool
	}{{"ledger", "alice", true, false}, {"ledger", "admin", false, false}, {"body", "alice", false, true}} {
		a, e := c.Decide(context.Background(), tc.producer, tc.user, "cent")
		if errors.Is(e, ErrForbidden) != tc.forbidden || a.CanOperate != tc.allowed {
			t.Fatal(tc, a, e)
		}
	}
	if _, err := New([]Definition{{Descriptor: Descriptor{ID: "currency", Code: "VVC", Name: "Coins", Precision: 2, Revision: "1"}}}, auth, nil); err == nil {
		t.Fatal("reinterpreted existing currency")
	}
}
