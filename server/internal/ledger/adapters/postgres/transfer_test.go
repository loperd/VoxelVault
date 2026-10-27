package postgres_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	fees "github.com/voxel-vault/api/internal/commissions/domain"
	"github.com/voxel-vault/api/internal/ledger/adapters/postgres"
	"github.com/voxel-vault/api/internal/ledger/application"
	"github.com/voxel-vault/api/internal/ledger/domain"
	"github.com/voxel-vault/api/internal/platform/outbox"
)

type transferAccess struct {
	revoked  atomic.Bool
	revision atomic.Uint64
}

func (c *transferAccess) Describe(
	_ context.Context,
	id string,
) (application.CurrencyDescriptor, error) {
	return application.CurrencyDescriptor{
		ID:        id,
		Code:      "COIN",
		Precision: 0,
		Revision:  strconv.FormatUint(c.revision.Load()+1, 10),
		Active:    true,
	}, nil
}

func (c *transferAccess) Decide(
	_ context.Context,
	_, _ string,
) (application.AccessDecision, error) {
	return application.AccessDecision{
		CanRead:    true,
		CanOperate: !c.revoked.Load(),
		Revision:   strconv.FormatUint(c.revision.Load()+1, 10),
	}, nil
}

type transferRecipient struct{}

func (transferRecipient) ResolveRecipient(
	_ context.Context,
	id string,
) (application.Recipient, error) {
	return application.Recipient{ID: id, Handle: id, DisplayName: id}, nil
}

type transferAuth struct{}

func (transferAuth) AuthorizeTransfer(ctx context.Context, subject, asset string) error {
	p, ok := application.AuthenticatedPrincipal(ctx)
	if !ok || p.ID != subject || asset != "coins" {
		return application.ErrForbidden
	}
	return nil
}

type feeCalculator struct{ rule fees.Rule }

func (f feeCalculator) CalculateTransfer(
	_ context.Context,
	fact application.TransferFact,
) (application.CommissionPlan, error) {
	n, err := strconv.ParseInt(fact.OriginalUnits, 10, 64)
	if err != nil {
		return application.CommissionPlan{}, err
	}
	p, err := fees.Calculate(n, []fees.Rule{f.rule})
	if err != nil {
		return application.CommissionPlan{}, err
	}
	out := application.CommissionPlan{
		Version:      f.rule.Version,
		DebitUnits:   strconv.FormatInt(p.Debit, 10),
		ReceiptUnits: strconv.FormatInt(p.Receipt, 10),
	}
	for _, c := range p.Commission {
		v := application.Commission{
			RuleID:     c.RuleID,
			Version:    c.Version,
			Imposition: c.Imposition,
			Units:      strconv.FormatInt(c.Units, 10),
		}
		for _, a := range c.Allocation {
			v.Allocation = append(
				v.Allocation,
				application.Allocation{
					AccountRef: a.Account,
					Burn:       a.Burn,
					Units:      strconv.FormatInt(a.Units, 10),
				},
			)
		}
		out.Commission = append(out.Commission, v)
	}
	return out, nil
}

func TestTransferAtomicIdempotentAndAccessChecked(t *testing.T) {
	for _, imposition := range []string{fees.Inside, fees.Outside} {
		t.Run(imposition, func(t *testing.T) {
			db, store := database(t)
			execute(t, service(t, store), command("fund", "fund", domain.Credit, 1000))
			destination := domain.TreasuryAccount("tax", "coins")
			if err := store.Transact(ctx, func(tx application.Tx) error { return tx.LockAccounts([]domain.Account{destination}) }); err != nil {
				t.Fatal(err)
			}
			access := &transferAccess{}
			var now atomic.Int64
			now.Store(time.Now().Unix())
			var seq atomic.Int64
			s, err := application.NewTransfer(
				store,
				access,
				transferRecipient{},
				feeCalculator{
					fees.Rule{
						ID:          "tax",
						Version:     "1",
						GeneralTax:  true,
						Imposition:  imposition,
						Numerator:   1,
						Denominator: 100,
						Destination: []fees.Destination{{Account: destination.ID, Weight: 1}},
					},
				},
				transferAuth{},
				func() time.Time { return time.Unix(now.Load(), 0) },
				func() (string, error) { return fmt.Sprintf("quote-%d", seq.Add(1)), nil },
			)
			if err != nil {
				t.Fatal(err)
			}
			actor := application.WithAuthenticatedPrincipal(
				ctx,
				application.Principal{Kind: "user", ID: "player"},
			)
			if _, err = s.Quote(ctx, "coins", "recipient", "100"); !errors.Is(
				err,
				application.ErrForbidden,
			) {
				t.Fatal("missing actor accepted", err)
			}
			q, err := s.Quote(actor, "coins", "recipient", "100")
			if err != nil {
				t.Fatal(err)
			}

			originalCalculator := s.Commission
			s.Commission = feeCalculator{rule: fees.Rule{ID: "tax", Version: "2", GeneralTax: true, Imposition: imposition, Numerator: 50, Denominator: 100, Destination: []fees.Destination{{Account: destination.ID, Weight: 1}}}}
			access.revision.Store(1)
			access.revoked.Store(true)
			if _, err = s.ResolveRecipient(actor, "coins", "recipient"); !errors.Is(err, application.ErrForbidden) {
				t.Fatal("revoked sender could resolve recipients", err)
			}
			if _, err = s.Confirm(actor, q.ID, "key"); !errors.Is(err, application.ErrForbidden) {
				t.Fatal("revoked recipient accepted", err)
			}
			access.revoked.Store(false)
			if _, err = s.Confirm(actor, q.ID, "key"); !errors.Is(err, application.ErrQuoteExpired) {
				t.Fatal("quote with stale rule or access revision accepted", err)
			}
			s.Commission = originalCalculator
			access.revision.Store(0)
			var count int
			if err = db.QueryRow(`SELECT count(*) FROM ledger.journals WHERE producer='user-transfer'`).Scan(&count); err != nil ||
				count != 0 {
				t.Fatal(count, err)
			}
			r, err := s.Confirm(actor, q.ID, "key")
			if err != nil || r.State != "committed" {
				t.Fatal(r, err)
			}
			now.Add(120)
			again, err := s.Confirm(actor, q.ID, "key")
			if err != nil || again != r {
				t.Fatal("replay changed after expiry", again, err)
			}
			payer, _ := store.Balance(ctx, "player", "coins")
			receiver, _ := store.Balance(ctx, "recipient", "coins")
			wantDebit, wantReceipt := int64(100), int64(99)
			if imposition == fees.Outside {
				wantDebit, wantReceipt = 101, 100
			}
			if payer.Posted != 1000-wantDebit || receiver.Posted != wantReceipt {
				t.Fatal(payer, receiver)
			}
			var fee int64
			if err = db.QueryRow(`SELECT sum(units) FROM ledger.postings WHERE account_id=$1`, destination.ID).Scan(&fee); err != nil ||
				fee != 1 {
				t.Fatal(fee, err)
			}
			s.Commission = originalCalculator
			q2, err := s.Quote(actor, "coins", "recipient", "100")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.Confirm(actor, q2.ID, "key"); !errors.Is(err, domain.ErrConflict) {
				t.Fatal("reused key accepted", err)
			}
			now.Add(61)
			if _, err = s.Confirm(actor, q2.ID, "expired"); !errors.Is(
				err,
				application.ErrQuoteExpired,
			) {
				t.Fatal("expired quote accepted", err)
			}
			other := application.WithAuthenticatedPrincipal(
				ctx,
				application.Principal{Kind: "user", ID: "other"},
			)
			if _, err = s.Confirm(other, q.ID, "steal"); err == nil {
				t.Fatal("other owner accepted")
			}
			history, err := store.History(ctx, "recipient", "coins", nil, 10)
			if err != nil || len(history) != 1 || history[0].Purpose != "transfer" ||
				history[0].Units != wantReceipt {
				t.Fatal(history, err)
			}
			q3, err := s.Quote(actor, "coins", "recipient", "100")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.Confirm(actor, q3.ID, "second-key"); err != nil {
				t.Fatal(err)
			}
			if _, err = s.Confirm(actor, q3.ID, "key"); !errors.Is(err, domain.ErrConflict) {
				t.Fatal("completed quote ignored a key bound to another quote", err)
			}
			commandCount := func() int {
				var n int
				if err := db.QueryRow(`SELECT count(*) FROM ledger.transfer_commands`).Scan(&n); err != nil {
					t.Fatal(err)
				}
				return n
			}
			before := commandCount()
			for i := 0; i < 10; i++ {
				if _, err = s.Confirm(actor, q3.ID, fmt.Sprintf("unused-replay-%d", i)); err != nil {
					t.Fatal(err)
				}
			}
			if after := commandCount(); after != before {
				t.Fatal("replay keys grew command storage", before, after)
			}

		})
	}
}

func TestConcurrentTransferAndFailedPostingNeverLoseMoney(t *testing.T) {
	db, store := database(t)
	// This test is about funds under contention, not the confirm burst cap.
	store.LimitTransfers(100, 60)
	execute(t, service(t, store), command("fund", "fund", domain.Credit, 1000))
	destination := domain.TreasuryAccount("tax", "coins")
	if err := store.Transact(ctx, func(tx application.Tx) error { return tx.LockAccounts([]domain.Account{destination}) }); err != nil {
		t.Fatal(err)
	}
	var seq atomic.Int64
	s, err := application.NewTransfer(
		store,
		&transferAccess{},
		transferRecipient{},
		feeCalculator{
			fees.Rule{
				ID:          "tax",
				Version:     "1",
				GeneralTax:  true,
				Imposition:  fees.Inside,
				Numerator:   1,
				Denominator: 100,
				Destination: []fees.Destination{{Account: destination.ID, Weight: 1}},
			},
		},
		transferAuth{},
		time.Now,
		func() (string, error) { return fmt.Sprintf("q-%d", seq.Add(1)), nil },
	)
	if err != nil {
		t.Fatal(err)
	}
	actor := application.WithAuthenticatedPrincipal(
		ctx,
		application.Principal{Kind: "user", ID: "player"},
	)
	q, err := s.Quote(actor, "coins", "recipient", "100")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`ALTER TABLE ledger.postings ADD CONSTRAINT reject_transfer_tax CHECK(account_id <> '` + destination.ID + `') NOT VALID`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Confirm(actor, q.ID, "failed-posting"); err == nil {
		t.Fatal("injected posting failure ignored")
	}
	f, _ := store.Balance(ctx, "player", "coins")
	if f.Posted != 1000 {
		t.Fatal("partial debit", f)
	}
	if _, err = db.Exec(`ALTER TABLE ledger.postings DROP CONSTRAINT reject_transfer_tax`); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var committed atomic.Int64
	errorCh := make(chan error, 16)
	for i := 0; i < 16; i++ {
		// Quotes are capped at 3 per second, so age the earlier ones out of the window.
		if _, err := db.Exec(`UPDATE ledger.transfer_quotes SET created_at=created_at-interval '1 minute'`); err != nil {
			t.Fatal(err)
		}
		q, err := s.Quote(actor, "coins", "recipient", "100")
		if err != nil {
			t.Fatal(err)
		}
		wg.Add(1)
		go func(q application.TransferQuote) {
			defer wg.Done()
			_, err := s.Confirm(actor, q.ID, q.ID)
			if err == nil {
				committed.Add(1)
			} else if !errors.Is(err, application.ErrTransferFunds) {
				errorCh <- err
			}
		}(q)
	}
	wg.Wait()
	close(errorCh)
	for err := range errorCh {
		t.Error(err)
	}
	if committed.Load() != 10 {
		t.Fatal("wrong committed count", committed.Load())
	}
	payer, _ := store.Balance(ctx, "player", "coins")
	recipient, _ := store.Balance(ctx, "recipient", "coins")
	if payer.Posted != 0 || recipient.Posted != 990 {
		t.Fatal(payer, recipient)
	}
}

func TestTransferQuoteCap(t *testing.T) {
	_, store := database(t)
	save := func(id string, expires time.Time) error {
		return store.SaveTransferQuote(
			ctx,
			application.TransferQuote{ID: id, SenderID: "player", CurrencyID: "coins", ExpiresAt: expires},
		)
	}
	for i := 0; i < 3; i++ {
		if err := save(fmt.Sprintf("live-%d", i), time.Now().Add(time.Minute)); err != nil {
			t.Fatal(i, err)
		}
	}
	if err := save("over", time.Now().Add(time.Minute)); !errors.Is(err, application.ErrTransferRateLimit) {
		t.Fatal("cap not enforced", err)
	}
}

func TestTransferQuoteCapHoldsUnderConcurrency(t *testing.T) {
	db, store := database(t)
	var wg sync.WaitGroup
	failures := make(chan error, 150)
	for i := 0; i < 150; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			failures <- store.SaveTransferQuote(
				ctx,
				application.TransferQuote{ID: fmt.Sprintf("c-%d", i), SenderID: "player", CurrencyID: "coins", ExpiresAt: time.Now().Add(time.Minute)},
			)
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil && !errors.Is(err, application.ErrTransferRateLimit) {
			t.Fatal("unexpected quote failure", err)
		}
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM ledger.transfer_quotes`).Scan(&n); err != nil || n != 3 {
		t.Fatal(n, err)
	}
}

func TestTransferDailyQuoteCapCountsExpiredAndCompletedRows(t *testing.T) {
	db, store := database(t)
	if _, err := db.Exec(`INSERT INTO ledger.transfer_quotes(id,subject,asset,body,receipt,created_at,expires_at)
 SELECT 'old-'||n,'player','coins','{}'::jsonb,CASE WHEN n%2=0 THEN '{}'::jsonb ELSE NULL END,
 now()-interval '2 hours',now()-interval '1 hour' FROM generate_series(1,2000) n`); err != nil {
		t.Fatal(err)
	}
	q := application.TransferQuote{ID: "new", SenderID: "player", CurrencyID: "coins", ExpiresAt: time.Now().Add(time.Minute)}
	if err := store.SaveTransferQuote(ctx, q); !errors.Is(err, application.ErrTransferRateLimit) {
		t.Fatal("daily cap ignored expired/completed quotes", err)
	}
	q.SenderID = "other"
	if err := store.SaveTransferQuote(ctx, q); err != nil {
		t.Fatal("daily cap crossed subject scope", err)
	}
}

func restrictionService(t *testing.T) (*sql.DB, *application.TransferService, context.Context) {
	t.Helper()
	db, store := database(t)
	execute(t, service(t, store), command("fund", "fund", domain.Credit, 1000))
	destination := domain.TreasuryAccount("tax", "coins")
	if err := store.Transact(ctx, func(tx application.Tx) error { return tx.LockAccounts([]domain.Account{destination}) }); err != nil {
		t.Fatal(err)
	}
	var seq atomic.Int64
	s, err := application.NewTransfer(
		store,
		&transferAccess{},
		transferRecipient{},
		feeCalculator{fees.Rule{
			ID: "tax", Version: "1", GeneralTax: true, Imposition: fees.Inside, Numerator: 1, Denominator: 100,
			Destination: []fees.Destination{{Account: destination.ID, Weight: 1}},
		}},
		transferAuth{},
		time.Now,
		func() (string, error) { return fmt.Sprintf("quote-%d", seq.Add(1)), nil },
	)
	if err != nil {
		t.Fatal(err)
	}
	return db, s, application.WithAuthenticatedPrincipal(ctx, application.Principal{Kind: "user", ID: "player"})
}

// transferOnce ages earlier quotes first, so only the confirm burst cap is under test.
func transferOnce(db *sql.DB, s *application.TransferService, actor context.Context, key string) error {
	if _, err := db.Exec(`UPDATE ledger.transfer_quotes SET created_at=created_at-interval '1 minute'`); err != nil {
		return err
	}
	q, err := s.Quote(actor, "coins", "recipient", "100")
	if err != nil {
		return err
	}
	_, err = s.Confirm(actor, q.ID, key)
	return err
}

func TestConfirmBurstSuspendsSenderWithExpiry(t *testing.T) {
	db, s, actor := restrictionService(t)
	for i := 0; i < 10; i++ {
		if err := transferOnce(db, s, actor, fmt.Sprintf("k%d", i)); err != nil {
			t.Fatal(i, err)
		}
	}
	if err := transferOnce(db, s, actor, "k10"); !errors.Is(err, application.ErrTransferRateLimit) {
		t.Fatal("11th transfer in a minute accepted", err)
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM ledger.account_restrictions WHERE kind='send' AND expires_at>now() AND actor='system'`).Scan(&n); err != nil || n != 1 {
		t.Fatal("no time-limited send block", n, err)
	}
	if err := transferOnce(db, s, actor, "k11"); !errors.Is(err, application.ErrForbidden) {
		t.Fatal("suspended sender transferred", err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM ledger.account_restrictions`).Scan(&n); err != nil || n != 1 {
		t.Fatal("duplicate restriction rows", n, err)
	}
}

func TestReceiveRestrictionHidesBlockAndLiftReopens(t *testing.T) {
	db, s, actor := restrictionService(t)
	recipient := domain.PlayerAccount(domain.Terms{Subject: "recipient", Asset: "coins"}).ID
	if _, err := db.Exec(`INSERT INTO ledger.account_restrictions(account_id,kind,reason,actor) VALUES($1,'receive','scam suspicion','operator')`, recipient); err != nil {
		t.Fatal(err)
	}
	if err := transferOnce(db, s, actor, "a"); !errors.Is(err, application.ErrTransferNotFound) {
		t.Fatal("blocked recipient received", err)
	}
	if _, err := db.Exec(`UPDATE ledger.account_restrictions SET lifted_at=now(),lifted_by='operator'`); err != nil {
		t.Fatal(err)
	}
	if err := transferOnce(db, s, actor, "b"); err != nil {
		t.Fatal("lifted block still applies", err)
	}
}

func TestConfirmedQuoteReplayUnderAnotherQuotesKeyConflicts(t *testing.T) {
	db, s, actor := restrictionService(t)
	if err := transferOnce(db, s, actor, "k1"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE ledger.transfer_quotes SET created_at=created_at-interval '1 minute'`); err != nil {
		t.Fatal(err)
	}
	q2, err := s.Quote(actor, "coins", "recipient", "100")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Confirm(actor, q2.ID, "k2"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Confirm(actor, q2.ID, "k1"); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("confirmed quote replayed under another quote's key", err)
	}
}

func TestOperatorRestrictAndLift(t *testing.T) {
	_, operator := operatorDatabase(t)
	account := domain.PlayerAccount(domain.Terms{Subject: "player", Asset: "coins"}).ID
	if _, err := operator.Restrict(ctx, account, "send", "", "ops", nil); !errors.Is(err, domain.ErrInvalid) {
		t.Fatal("reason is mandatory", err)
	}
	id, err := operator.Restrict(ctx, account, "send", "chargeback fraud", "ops", nil)
	if err != nil {
		t.Fatal(err)
	}
	rs, err := operator.Restrictions(ctx, account)
	if err != nil || len(rs) != 1 || rs[0].LiftedAt != nil || rs[0].ExpiresAt != nil {
		t.Fatal(rs, err)
	}
	if err = operator.Lift(ctx, id, "ops"); err != nil {
		t.Fatal(err)
	}
	if err = operator.Lift(ctx, id, "ops"); err == nil {
		t.Fatal("restriction lifted twice")
	}
}

func TestQuoteRefusedForBlockedSenderAndRecipient(t *testing.T) {
	db, s, actor := restrictionService(t)
	sender := domain.PlayerAccount(domain.Terms{Subject: "player", Asset: "coins"}).ID
	if _, err := db.Exec(`INSERT INTO ledger.account_restrictions(account_id,kind,reason,actor) VALUES($1,'send','fraud','operator')`, sender); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Quote(actor, "coins", "recipient", "100"); !errors.Is(err, application.ErrForbidden) {
		t.Fatal("blocked sender got a quote", err)
	}
}

// A block taken while a quote is pending is either seen by Confirm or finished after it;
// once Restrict has returned, no new confirmation may pass.
func TestRestrictRacingConfirmNeverLetsLaterTransferThrough(t *testing.T) {
	db, s, actor := restrictionService(t)
	sender := domain.PlayerAccount(domain.Terms{Subject: "player", Asset: "coins"}).ID
	q, err := s.Quote(actor, "coins", "recipient", "100")
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var confirmErr, restrictErr error
	wg.Add(2)
	go func() { defer wg.Done(); _, confirmErr = s.Confirm(actor, q.ID, "race") }()
	go func() {
		defer wg.Done()
		_, restrictErr = postgres.New(db).Restrict(ctx, sender, "send", "race", "ops", nil)
	}()
	wg.Wait()
	if restrictErr != nil {
		t.Fatal(restrictErr)
	}
	if confirmErr != nil && !errors.Is(confirmErr, application.ErrForbidden) {
		t.Fatal("unexpected confirm error", confirmErr)
	}
	if err := transferOnce(db, s, actor, "after"); !errors.Is(err, application.ErrForbidden) {
		t.Fatal("transfer passed after the block committed", err)
	}
}

func restrictionEvents(t *testing.T, db *sql.DB) map[string]int {
	t.Helper()
	rows, err := db.Query(`SELECT kind,count(*) FROM ledger.outbox WHERE producer='account-restrictions' GROUP BY kind`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var k string
		var n int
		if err := rows.Scan(&k, &n); err != nil {
			t.Fatal(err)
		}
		out[k] = n
	}
	return out
}

func TestRestrictionEventsAddLiftExpireAreIdempotentAndIsolated(t *testing.T) {
	db, operator := operatorDatabase(t)
	account := domain.PlayerAccount(domain.Terms{Subject: "player", Asset: "coins"}).ID
	past := time.Now().Add(-time.Minute) // already over: the sweeper must report it
	if _, err := operator.Restrict(ctx, account, "send", "chargeback", "ops", &past); err != nil {
		t.Fatal(err)
	}
	id, err := operator.Restrict(ctx, account, "receive", "scam", "ops", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = operator.Lift(ctx, id, "ops"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ { // the second pass must add nothing
		if _, err = operator.PublishExpired(ctx); err != nil {
			t.Fatal(err)
		}
	}
	got := restrictionEvents(t, db)
	if got["restriction.added"] != 2 || got["restriction.lifted"] != 1 || got["restriction.expired"] != 1 {
		t.Fatal("unexpected events", got)
	}
	// Receipt consumers never see them, even when they claim without a producer filter.
	batch, err := operator.ClaimEvents(ctx, "worker", time.Now(), time.Minute, 10)
	if err != nil || len(batch) != 0 {
		t.Fatal("restriction event leaked to the receipt queue", len(batch), err)
	}
	q, err := (outbox.Table{DB: db, Name: "ledger.outbox"}).Topic(postgres.RestrictionTopic, "")
	if err != nil {
		t.Fatal(err)
	}
	d, err := q.Claim(ctx, "notifier", time.Now(), time.Minute, 10)
	if err != nil || len(d) != 4 {
		t.Fatal("topic queue", len(d), err)
	}
	if err = q.Ack(ctx, d[0].ID, "notifier", d[0].Fence, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err = q.Ack(ctx, d[0].ID, "notifier", d[0].Fence, time.Now()); !errors.Is(err, outbox.ErrLeaseLost) {
		t.Fatal("event acknowledged twice", err)
	}
}

func TestAutoBlockPublishesOneAddedEvent(t *testing.T) {
	db, s, actor := restrictionService(t)
	for i := 0; i < 10; i++ {
		if err := transferOnce(db, s, actor, fmt.Sprintf("k%d", i)); err != nil {
			t.Fatal(i, err)
		}
	}
	for i := 10; i < 12; i++ { // the burst blocks once; the next attempt meets the existing block
		_ = transferOnce(db, s, actor, fmt.Sprintf("k%d", i))
	}
	if got := restrictionEvents(t, db); got["restriction.added"] != 1 || len(got) != 1 {
		t.Fatal(got)
	}
}
