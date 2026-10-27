package v1

import "context"

type Error struct{ Code string }

func (e *Error) Error() string { return "currency: " + e.Code }

type Descriptor struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	Name      string `json:"name"`
	Precision uint8  `json:"precision"`
	Active    bool   `json:"active"`
	Revision  string `json:"revision"`
}
type AccessDecision struct {
	CanRead    bool   `json:"canRead"`
	CanOperate bool   `json:"canOperate"`
	Revision   string `json:"revision"`
}
type Provider interface {
	Describe(context.Context, string) (Descriptor, error)
	Decide(context.Context, string, string) (AccessDecision, error)
	List(context.Context, string) ([]Descriptor, error)
}
