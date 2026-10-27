// account-restrict adds, lifts and lists send/receive restrictions on a player's
// ledger account. It needs the operator WALLET_DATABASE_URL: the API runtime role
// cannot lift a block. A frozen account is one send plus one receive restriction.
//
//	account-restrict add  -subject S -asset A -kind send|receive -reason R -actor ID [-minutes N]
//	account-restrict lift -id N -actor ID
//	account-restrict list -subject S -asset A
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/voxel-vault/api/ledger/adapters/postgres"
	"github.com/voxel-vault/api/ledger/domain"
)

func fail(args ...any) {
	fmt.Fprintln(os.Stderr, args...)
	os.Exit(1)
}

func main() {
	if len(os.Args) < 2 {
		fail("usage: account-restrict add|lift|list [flags]")
	}
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	subject := fs.String("subject", "", "player subject")
	asset := fs.String("asset", "", "currency asset")
	kind := fs.String("kind", "", "send or receive")
	reason := fs.String("reason", "", "mandatory reason")
	actor := fs.String("actor", "", "operator identity")
	minutes := fs.Int("minutes", 0, "block length; 0 = until lifted")
	id := fs.Int64("id", 0, "restriction id")
	fs.Parse(os.Args[2:])
	dsn := os.Getenv("WALLET_DATABASE_URL")
	if dsn == "" {
		fail("WALLET_DATABASE_URL operator connection is required")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		fail("invalid Wallet connection")
	}
	defer db.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	store := postgres.New(db)
	account := domain.PlayerAccount(domain.Terms{Subject: *subject, Asset: *asset}).ID
	switch os.Args[1] {
	case "add":
		var expires *time.Time
		if *minutes > 0 {
			t := time.Now().Add(time.Duration(*minutes) * time.Minute)
			expires = &t
		}
		n, err := store.Restrict(ctx, account, *kind, *reason, *actor, expires)
		if err != nil {
			fail("add failed:", err)
		}
		fmt.Println(n)
	case "lift":
		if err := store.Lift(ctx, *id, *actor); err != nil {
			fail("lift failed:", err)
		}
	case "list":
		rs, err := store.Restrictions(ctx, account)
		if err != nil {
			fail("list failed:", err)
		}
		for _, r := range rs {
			fmt.Printf("%d %s created=%s expires=%v lifted=%v by=%q actor=%q reason=%q\n", r.ID, r.Kind, r.CreatedAt.Format(time.RFC3339), r.ExpiresAt, r.LiftedAt, r.LiftedBy, r.Actor, r.Reason)
		}
	default:
		fail("usage: account-restrict add|lift|list [flags]")
	}
}
