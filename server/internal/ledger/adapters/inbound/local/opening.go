package local

import (
	"context"
	"strconv"
	"time"

	"github.com/voxel-vault/api/internal/ledger/application"
	v1 "github.com/voxel-vault/api/internal/ledger/contracts/v1"
)

type OpeningClient struct{ Service application.OpeningService }

func (c OpeningClient) ImportOpening(ctx context.Context, in v1.Opening) error {
	at, err := time.Parse(time.RFC3339Nano, in.At)
	if err != nil {
		return &v1.Error{Code: v1.Invalid}
	}
	r := application.Opening{Source: in.Source, Digest: in.Digest, At: at}
	for _, b := range in.Balances {
		n, err := strconv.ParseInt(b.Units, 10, 64)
		if err != nil || n < 0 || strconv.FormatInt(n, 10) != b.Units {
			return &v1.Error{Code: v1.Invalid}
		}
		r.Balances = append(r.Balances, application.OpeningBalance{Subject: b.Subject, Asset: b.Asset, Units: n})
	}
	return publicError(c.Service.Import(ctx, r))
}
