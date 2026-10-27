package application

import (
	"context"
	"errors"
	"github.com/voxel-vault/api/inventory/domain"
	"time"
)

var ErrLeaseLost = errors.New("inventory delivery lease lost")

// PermanentFailure is a local integration failure classification, not a Wallet error type.
type PermanentFailure struct{ Code string }

func (e *PermanentFailure) Error() string { return "settlement integration: " + e.Code }

type Settlement interface {
	Execute(context.Context, domain.SettlementCommand) (domain.SettlementFact, error)
}
type Job struct {
	Command  domain.SettlementCommand
	Fence    int64
	Attempts int
}
type Jobs interface {
	ClaimJobs(context.Context, string, time.Time, time.Duration, int) ([]Job, error)
	FinishJob(context.Context, string, string, int64, time.Time, string) error
	RetryJob(context.Context, string, string, int64, time.Time, time.Time) error
}
type Worker struct {
	Store      Jobs
	Settlement Settlement
	Service    *Service
	Owner      string
	Clock      func() time.Time
	Lease      time.Duration
	Limit      int
	Authorizer Authorizer
}
type Stats struct{ Claimed, Completed, Retried, Failed int }

func (w Worker) RunOnce(ctx context.Context) (Stats, error) {
	var stats Stats
	var authorizationErr error
	ctx, authorizationErr = authorize(ctx, w.Authorizer, ExecuteDelivery, Resource{Kind: "delivery_queue", ID: "inventory-settlement"})
	if authorizationErr != nil {
		return stats, authorizationErr
	}
	if w.Store == nil || w.Settlement == nil || w.Service == nil || !domain.ValidID(w.Owner) || w.Clock == nil || w.Lease <= 0 || w.Limit < 1 || w.Limit > 256 {
		return stats, domain.ErrInvalid
	}
	batch, err := w.Store.ClaimJobs(ctx, w.Owner, w.Clock().UTC(), w.Lease, w.Limit)
	if err != nil {
		return stats, err
	}
	stats.Claimed = len(batch)
	var failures []error
	for _, job := range batch {
		jobContext := WithOperationScope(ctx, job.Command.IntentID)
		fact, deliveryErr := w.Settlement.Execute(jobContext, job.Command)
		code := ""
		var permanent *PermanentFailure
		if errors.As(deliveryErr, &permanent) {
			code = permanent.Code
			deliveryErr = w.Service.Reconcile(jobContext, job.Command.IntentID, code)
		} else if deliveryErr == nil {
			deliveryErr = w.Service.Observe(jobContext, domain.Identity("reply", job.Command.ID), fact)
		}
		now := w.Clock().UTC()
		if deliveryErr != nil {
			delay := time.Second * time.Duration(1<<min(job.Attempts, 5))
			if err := w.Store.RetryJob(ctx, job.Command.ID, w.Owner, job.Fence, now, now.Add(delay)); err != nil {
				failures = append(failures, err)
			}
			failures = append(failures, deliveryErr)
			stats.Retried++
			continue
		}
		if err := w.Store.FinishJob(ctx, job.Command.ID, w.Owner, job.Fence, now, code); err != nil {
			failures = append(failures, err)
			continue
		}
		if code != "" {
			stats.Failed++
		} else {
			stats.Completed++
		}
	}
	return stats, errors.Join(failures...)
}
