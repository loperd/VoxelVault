// ledgerctl drives Ledger admin requests from inside the cluster (kubectl exec into an API pod)
// straight against the Ledger database. A request runs only after three parties sign it; the
// secret key stays with its holder, only signatures reach the database.
//
//	ledgerctl keygen
//	ledgerctl allocate FROM TO ASSET UNITS   create a request (does not sign it)
//	ledgerctl show ID
//	ledgerctl sign ID                        shows the payload, signs after you confirm
//	ledgerctl execute ID
//
// Environment: WALLET_DATABASE_URL, and for allocate/sign LEDGER_ADMIN_KEY_ID and
// LEDGER_ADMIN_SECRET_KEY (hex, from keygen).
package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/voxel-vault/api/ledger/adapters/postgres"
)

func fail(args ...any) {
	fmt.Fprintln(os.Stderr, args...)
	os.Exit(1)
}

func key() (string, ed25519.PrivateKey) {
	id, secret := os.Getenv("LEDGER_ADMIN_KEY_ID"), os.Getenv("LEDGER_ADMIN_SECRET_KEY")
	raw, err := hex.DecodeString(secret)
	if id == "" || err != nil || len(raw) != ed25519.PrivateKeySize {
		fail("LEDGER_ADMIN_KEY_ID and LEDGER_ADMIN_SECRET_KEY (hex) are required")
	}
	return id, ed25519.PrivateKey(raw)
}

func sign(priv ed25519.PrivateKey, action, payload string) []byte {
	return ed25519.Sign(priv, postgres.AdminMessage(action, payload))
}

func store() (*postgres.Store, func()) {
	dsn := os.Getenv("WALLET_DATABASE_URL")
	if dsn == "" {
		fail("WALLET_DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		fail("invalid WALLET_DATABASE_URL")
	}
	return postgres.New(db), func() { db.Close() }
}

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		fail("usage: ledgerctl keygen | allocate FROM TO ASSET UNITS | show ID | sign ID | execute ID")
	}
	ctx := context.Background()
	if args[0] == "keygen" {
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			fail(err)
		}
		fmt.Println("public: ", hex.EncodeToString(pub))
		fmt.Println("secret: ", hex.EncodeToString(priv))
		return
	}
	s, closeDB := store()
	defer closeDB()
	switch {
	case args[0] == "allocate" && len(args) == 5:
		units, err := strconv.ParseInt(args[4], 10, 64)
		if err != nil {
			fail("UNITS must be an integer")
		}
		nonce := make([]byte, 8)
		rand.Read(nonce)
		payload, _ := json.Marshal(postgres.Allocation{From: args[1], To: args[2], Asset: args[3], Units: units, Nonce: hex.EncodeToString(nonce)})
		id, priv := key()
		request, err := s.AdminCreate(ctx, id, "allocate", string(payload), sign(priv, "allocate", string(payload)))
		if err != nil {
			fail(err)
		}
		fmt.Println(request)
	case args[0] == "show" && len(args) == 2:
		action, payload, signers, executed, err := s.AdminRequest(ctx, args[1])
		if err != nil {
			fail(err)
		}
		fmt.Printf("action:  %s\npayload: %s\nsigned:  %v\nran:     %v\n", action, payload, signers, executed)
	case args[0] == "sign" && len(args) == 2:
		action, payload, _, _, err := s.AdminRequest(ctx, args[1])
		if err != nil {
			fail(err)
		}
		fmt.Printf("action:  %s\npayload: %s\nSign this request? [y/N] ", action, payload)
		if answer, _ := bufio.NewReader(os.Stdin).ReadString('\n'); strings.TrimSpace(answer) != "y" {
			fail("not signed")
		}
		id, priv := key()
		if err = s.AdminSign(ctx, args[1], id, sign(priv, action, payload)); err != nil {
			fail(err)
		}
		fmt.Println("signed")
	case args[0] == "execute" && len(args) == 2:
		if err := s.AdminExecute(ctx, args[1], time.Now().UTC()); err != nil {
			fail(err)
		}
		fmt.Println("executed")
	default:
		fail("unknown command")
	}
}
