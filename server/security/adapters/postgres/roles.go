package postgres

import (
	"context"
	"database/sql"
	"github.com/voxel-vault/api/security/application"
)

type Roles struct{ DB *sql.DB }

func (r Roles) Roles(ctx context.Context, actor application.Actor) ([]string, error) {
	if actor.Kind != "user" {
		return nil, nil
	}
	if r.DB == nil {
		return nil, application.ErrInvalid
	}
	return (Subjects{DB: r.DB}).Roles(ctx, actor.ID)
}
