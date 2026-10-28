// ledgerctl drives Ledger admin requests over the internal endpoint. A request runs only after
// three parties sign it; the secret key never leaves the machine, only signatures do.
//
//	ledgerctl keygen
//	ledgerctl allocate FROM TO ASSET UNITS   create a request (does not sign it)
//	ledgerctl show ID
//	ledgerctl sign ID                        shows the payload, signs after you confirm
//	ledgerctl execute ID
//
// Environment: LEDGER_ADMIN_URL, and for allocate/sign LEDGER_ADMIN_KEY_ID and
// LEDGER_ADMIN_SECRET_KEY (hex, from keygen).
package main

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/voxel-vault/api/ledger/adapters/postgres"
)

func fail(args ...any) {
	fmt.Fprintln(os.Stderr, args...)
	os.Exit(1)
}

func call(method, path string, in any) map[string]any {
	base := os.Getenv("LEDGER_ADMIN_URL")
	if base == "" {
		fail("LEDGER_ADMIN_URL is required")
	}
	raw, _ := json.Marshal(in)
	req, err := http.NewRequest(method, strings.TrimRight(base, "/")+"/internal/ledger-admin/requests"+path, bytes.NewReader(raw))
	if err != nil {
		fail(err)
	}
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		fail(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != 200 {
		fail(res.Status, strings.TrimSpace(string(data)))
	}
	out := map[string]any{}
	if err = json.Unmarshal(data, &out); err != nil {
		fail("unreadable response")
	}
	return out
}

func key() (string, ed25519.PrivateKey) {
	id, secret := os.Getenv("LEDGER_ADMIN_KEY_ID"), os.Getenv("LEDGER_ADMIN_SECRET_KEY")
	raw, err := hex.DecodeString(secret)
	if id == "" || err != nil || len(raw) != ed25519.PrivateKeySize {
		fail("LEDGER_ADMIN_KEY_ID and LEDGER_ADMIN_SECRET_KEY (hex) are required")
	}
	return id, ed25519.PrivateKey(raw)
}

func sign(priv ed25519.PrivateKey, action, payload string) string {
	return hex.EncodeToString(ed25519.Sign(priv, postgres.AdminMessage(action, payload)))
}

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		fail("usage: ledgerctl keygen | allocate FROM TO ASSET UNITS | show ID | sign ID | execute ID")
	}
	switch {
	case args[0] == "keygen":
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			fail(err)
		}
		fmt.Println("public: ", hex.EncodeToString(pub))
		fmt.Println("secret: ", hex.EncodeToString(priv))
	case args[0] == "allocate" && len(args) == 5:
		units, err := strconv.ParseInt(args[4], 10, 64)
		if err != nil {
			fail("UNITS must be an integer")
		}
		nonce := make([]byte, 8)
		rand.Read(nonce)
		payload, _ := json.Marshal(postgres.Allocation{From: args[1], To: args[2], Asset: args[3], Units: units, Nonce: hex.EncodeToString(nonce)})
		id, priv := key()
		out := call("POST", "", map[string]string{"key_id": id, "action": "allocate", "payload": string(payload), "signature": sign(priv, "allocate", string(payload))})
		fmt.Println(out["id"])
	case args[0] == "show" && len(args) == 2:
		out := call("GET", "/"+args[1], nil)
		fmt.Printf("action:  %v\npayload: %v\nsigned:  %v\nran:     %v\n", out["action"], out["payload"], out["signers"], out["executed"])
	case args[0] == "sign" && len(args) == 2:
		out := call("GET", "/"+args[1], nil)
		action, payload := fmt.Sprint(out["action"]), fmt.Sprint(out["payload"])
		fmt.Printf("action:  %s\npayload: %s\nSign this request? [y/N] ", action, payload)
		if answer, _ := bufio.NewReader(os.Stdin).ReadString('\n'); strings.TrimSpace(answer) != "y" {
			fail("not signed")
		}
		id, priv := key()
		call("POST", "/"+args[1]+"/signatures", map[string]string{"key_id": id, "signature": sign(priv, action, payload)})
		fmt.Println("signed")
	case args[0] == "execute" && len(args) == 2:
		call("POST", "/"+args[1]+"/execute", struct{}{})
		fmt.Println("executed")
	default:
		fail("unknown command")
	}
}
