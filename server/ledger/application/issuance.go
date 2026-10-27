package application

import (
	"context"
	"github.com/voxel-vault/api/ledger/domain"
)

// Issuance describes an entire opening allocation, including zero/empty baselines.
// Limits apply to aggregate units per asset, rather than individual postings.
type Issuance struct {
	Purpose                     domain.Purpose
	Source, Reference, Treasury string
	Totals                      map[string]int64
}

type IssuanceAuthorizer interface {
	AuthorizeIssuance(context.Context, string, Issuance) error
}

func authorizeIssuance(ctx context.Context, auth Authorizer, producer string, request Issuance) error {
	gate, ok := auth.(IssuanceAuthorizer)
	if !ok {
		return ErrForbidden
	}
	return gate.AuthorizeIssuance(ctx, producer, request)
}
