package postgres_test

import (
	"context"
	"github.com/voxel-vault/api/inventory/application"
)

type allowInventory struct{}

func (allowInventory) Authorize(context.Context, application.AccessRequest) (application.Decision, error) {
	return application.Decision{PolicyVersion: "test-fixture"}, nil
}
