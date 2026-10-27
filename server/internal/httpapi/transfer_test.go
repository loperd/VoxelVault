package httpapi

import (
	"context"
	"fmt"
	"testing"

	ledger "github.com/voxel-vault/api/internal/ledger/application"
	v1 "github.com/voxel-vault/api/internal/ledger/contracts/v1"
)

func TestTransferQuoteConfirmationAndHistoryThroughGateway(t *testing.T) {
	f := httpStack(t, true)
	var recipient v1.Recipient
	decodeResponse(
		t,
		f.request("GET", "/api/v1/wallet/recipient?asset=currency&query=bob", "alice", "", ""),
		200,
		&recipient,
	)
	if recipient.ID != "bob" {
		t.Fatal(recipient)
	}
	var quote v1.Quote
	decodeResponse(
		t,
		f.request(
			"POST",
			"/api/v1/wallet/quotes",
			"alice",
			"",
			`{"asset":"currency","recipient":"bob","units":"100"}`,
		),
		201,
		&quote,
	)
	if quote.DebitUnits != "100" || quote.ReceiptUnits != "99" || len(quote.Commission) != 1 ||
		quote.Commission[0].Units != "1" {
		t.Fatal(quote)
	}
	body := fmt.Sprintf(`{"quoteId":%q}`, quote.ID)
	decodeResponse(
		t,
		f.request("POST", "/api/v1/wallet/transfers", "bob", "foreign-key", body),
		404,
		nil,
	)
	var receipt v1.TransferReceipt
	decodeResponse(
		t,
		f.request("POST", "/api/v1/wallet/transfers", "alice", "confirmation-key", body),
		200,
		&receipt,
	)
	var replay v1.TransferReceipt
	decodeResponse(
		t,
		f.request("POST", "/api/v1/wallet/transfers", "alice", "confirmation-key", body),
		200,
		&replay,
	)
	if receipt != replay || receipt.State != "committed" {
		t.Fatal(receipt, replay)
	}
	var history v1.History
	decodeResponse(
		t,
		f.request("GET", "/api/v1/wallet/transactions?asset=currency", "bob", "", ""),
		200,
		&history,
	)
	if len(history.Entries) < 1 || history.Entries[0].Purpose != "transfer" ||
		history.Entries[0].Units != "99" ||
		history.Entries[0].Direction != "credit" || history.Entries[0].Status != "credited" {
		t.Fatal(history)
	}
	decodeResponse(
		t,
		f.request(
			"POST",
			"/api/v1/wallet/quotes",
			"alice",
			"",
			`{"asset":"currency","recipient":"bob","units":"1"}`,
		),
		400,
		nil,
	)
	decodeResponse(
		t,
		f.request(
			"POST",
			"/api/v1/wallet/quotes",
			"",
			"",
			`{"asset":"currency","recipient":"bob","units":"100"}`,
		),
		401,
		nil,
	)
	if _, err := f.runtime.Transfer.QuoteTransfer(context.Background(), "currency", "bob", "100"); err == nil {
		t.Fatal("direct port accepted an unauthenticated request")
	}
	actor := f.runtime.UserContext(context.Background(), "alice")
	httpExec(t, f.securityDB, `DELETE FROM security.role_bindings WHERE subject='alice'`)
	if _, err := f.runtime.Transfer.QuoteTransfer(actor, "currency", "bob", "100"); err == nil {
		t.Fatal("direct port accepted a revoked role")
	}
	forged := ledger.WithAuthenticatedPrincipal(
		context.Background(),
		ledger.Principal{Kind: "service", ID: "alice"},
	)
	if _, err := f.runtime.Transfer.QuoteTransfer(forged, "currency", "bob", "100"); err == nil {
		t.Fatal("service identity accepted as a user")
	}
}
