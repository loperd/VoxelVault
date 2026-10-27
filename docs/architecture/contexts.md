# Bounded contexts and settlement sagas

Status: Inventory–Ledger settlement and the first internal-transfer slice are implemented. External payment providers, exchange and group administration remain deferred.

## Ownership

| Context | Owns |
|---|---|
| Inventory | Owned items, condition, server quotes, repair, salvage, sale and item reservations |
| Ledger | Accounts, assets, immutable double-entry postings, balances, funds reservations and settlement |
| Currency | Administrator-configured currency descriptors, precision and availability to everyone, users or groups |
| Commissions | Versioned fee rules, exact calculation and allocation instructions; no postings |
| Identity/Profile | Player identity, credentials, external account links and preferences |
| Shop (future) | Offers, orders and purchase policy |

Ledger must support independent deployment from the start. No cross-context SQL transaction, foreign table read, shared ORM/domain model, aggregate transfer or direct repository call is allowed. Each context owns its persistence schema and migrations, even when hosted in one process or PostgreSQL instance.

Each consumer declares an outbound port in its application layer. An integration adapter translates local requests into the provider's versioned public contract and translates responses back into local values. Only adapters and the composition root know the implementation or transport. Domain/application code must not import another context's internals. Switching local transport to HTTP or messaging must not change domain rules or use cases.

## Durable saga

A cross-context workflow is a persisted saga, not an in-memory sequence of calls. Its coordinator owns operation identity, state, the frozen server quote, command IDs and step outcomes. It does not own items or accounts, and addresses participants only through its ports. Future Shop uses the same principle for its own order saga.

### Repair

1. Inventory reserves the item and freezes its quote.
2. Ledger reserves the required funds.
3. Inventory commits the repair while retaining the item lock.
4. Ledger confirms the debit.
5. Inventory releases the item lock and the saga completes.

After the repair is committed, debit confirmation must be retried until its outcome is known. A timeout is not a rejection and cannot release the funds reservation. Before repair commitment, cancellation releases both reservations through idempotent commands. Expiration, if supported, must be coordinated with the saga decision; participants cannot independently expire an already committed operation.

### Sale and salvage

Inventory reserves the item and commits its consumption with an outgoing event. Ledger credits the compensation, and the saga acknowledges completion. The UI shows the operation as pending until settlement is confirmed. A failed delivery is retried, and the consumed item cannot be sold or salvaged again.

A definitive business rejection may restore the item only after confirmed absence of credit, or after a separate Ledger compensation succeeds. Transport errors and timeouts do not prove absence. Unresolvable conflicts enter an explicit reconciliation state instead of silently disappearing.

## Internal transfers

Wallet is the player-facing balance/history and transfer workflow. Ledger owns the sole monetary book; treasury is an ordinary account. Identity resolves an exact handle or stable ID, Currency decides eligibility and Commissions computes each fee independently from the original amount. Groups are membership facts, not roles.

A persisted server quote freezes the recipient, precision, original amount, fees, debit, receipt and rule version for 60 seconds without reserving funds. Each fee uses inside/outside imposition, half-up rounding and largest-remainder allocation. A general tax that rounds to zero rejects the quote.

Confirmation requires authenticated identity, fresh permission and current sender/recipient currency access before entering the Ledger transaction. Access revocation is not serialized across contexts with settlement. Within Ledger, account locks, available-funds validation, postings and idempotency receipts commit atomically. Repeating confirmation returns the committed receipt, including after quote expiry; a key reused for another quote conflicts. Failed or expired uncommitted quotes move no money.

Configured currencies with zero balances remain visible. Revoked holdings and history remain readable, while transfers are blocked. The browser clears account-scoped drafts and stale history when the account or selected currency changes.

## Delivery and recovery

Each participant atomically persists only its own state, inbox deduplication and outbox within its own local transaction. Delivery is at least once; duplicate handling must not repeat the business effect. An outbox dispatcher uses retries and recoverable job leases. A background recovery process resumes unfinished sagas independently of the HTTP request or browser.

Operation IDs and command IDs survive retries. The same ID and payload return the existing result; the same ID with a different payload is a conflict. Messages carry contract version, message ID, correlation/causation IDs and business operation ID. Receivers validate state transitions under duplicate and out-of-order delivery. Resolve unknown outcomes by repeating the same command or querying status through a port, never by inventing a new operation ID.

## Ledger invariants

Every posted transaction balances debit and credit in each asset. Ledger postings are immutable; corrections create a balanced compensating transaction linked to the original. Posted balance is derived from postings. Available balance subtracts active reservations; a reservation is not a final debit. Player funds cannot be overspent, and amounts use positive `int64` minimum units, with currency precision from 0 to 18. HTTP amounts are decimal strings and browser arithmetic uses `BigInt`; the existing `currency` retains precision 0.

Funds checks, reservation transitions, postings, inbox and outbox are atomic only within Ledger. Internal storage transactions do not become a distributed transaction with Inventory or Shop.

Inventory computes workshop compensation and costs from trusted server rules and freezes them before settlement. Ledger authorizes the initiating integration and operation type; the browser cannot issue arbitrary credits. Existing balances migrate through explicitly labeled opening-balance postings. Do not fabricate historical sales to explain them.

## Identity and UI

Wallet has its own section and history backed by Ledger. Inventory presents objects, not currencies or character portraits in place of items. Read models may combine public responses for display, without writing another context's models.

Provider linking proves ownership of the current account and the new external identity. It must not capture an identity attached to another account. Passkey addition must attach to the current player rather than create a second player. Future providers use the same public linking boundary.

## Migration acceptance

`server/internal/domain/inventory` still uses the legacy `domain/wallet` value model for pricing. It is not a second authoritative balance store. Runtime settlement uses `server/internal/ledger` through published contracts and the `inventoryledger` integration.

Automated import checks must reject domain/application dependencies on adapters and foreign contexts. Failure tests must interrupt processing after each local commit, restart workers, duplicate and reorder messages, and exercise concurrent commands against the same item/account. Verify no repeated consumption or credit, no negative available balance, balanced postings, conflicting-ID rejection and eventual completion or an observable reconciliation state.
