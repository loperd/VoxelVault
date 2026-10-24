# Bounded contexts and settlement sagas

Status: accepted target architecture, agreed on 2026-10-22. The existing backend has not yet been migrated to this design.

## Ownership

| Context | Owns |
|---|---|
| Inventory | Owned items, condition, server quotes, repair, salvage, sale and item reservations |
| Wallet | Accounts, assets, immutable double-entry postings, balances, funds reservations and settlement |
| Identity/Profile | Player identity, credentials, external account links and preferences |
| Shop (future) | Offers, orders and purchase policy |

Wallet must support independent deployment from the start. No cross-context SQL transaction, foreign table read, shared ORM/domain model, aggregate transfer or direct repository call is allowed. Each context owns its persistence schema and migrations, even when hosted in one process or PostgreSQL instance.

Each consumer declares an outbound port in its application layer. An integration adapter translates local requests into the provider's versioned public contract and translates responses back into local values. Only adapters and the composition root know the implementation or transport. Domain/application code must not import another context's internals. Switching local transport to HTTP or messaging must not change domain rules or use cases.

## Durable saga

A cross-context workflow is a persisted saga, not an in-memory sequence of calls. Its coordinator owns operation identity, state, the frozen server quote, command IDs and step outcomes. It does not own items or accounts, and addresses participants only through its ports. Future Shop uses the same principle for its own order saga.

### Repair

1. Inventory reserves the item and freezes its quote.
2. Wallet reserves the required funds.
3. Inventory commits the repair while retaining the item lock.
4. Wallet confirms the debit.
5. Inventory releases the item lock and the saga completes.

After the repair is committed, debit confirmation must be retried until its outcome is known. A timeout is not a rejection and cannot release the funds reservation. Before repair commitment, cancellation releases both reservations through idempotent commands. Expiration, if supported, must be coordinated with the saga decision; participants cannot independently expire an already committed operation.

### Sale and salvage

Inventory reserves the item and commits its consumption with an outgoing event. Wallet credits the compensation, and the saga acknowledges completion. The UI shows the operation as pending until settlement is confirmed. A failed delivery is retried, and the consumed item cannot be sold or salvaged again.

A definitive business rejection may restore the item only after confirmed absence of credit, or after a separate Wallet compensation succeeds. Transport errors and timeouts do not prove absence. Unresolvable conflicts enter an explicit reconciliation state instead of silently disappearing.

## Delivery and recovery

Each participant atomically persists only its own state, inbox deduplication and outbox within its own local transaction. Delivery is at least once; duplicate handling must not repeat the business effect. An outbox dispatcher uses retries and recoverable job leases. A background recovery process resumes unfinished sagas independently of the HTTP request or browser.

Operation IDs and command IDs survive retries. The same ID and payload return the existing result; the same ID with a different payload is a conflict. Messages carry contract version, message ID, correlation/causation IDs and business operation ID. Receivers validate state transitions under duplicate and out-of-order delivery. Resolve unknown outcomes by repeating the same command or querying status through a port, never by inventing a new operation ID.

## Wallet invariants

Every posted transaction balances debit and credit in each asset. Ledger postings are immutable; corrections create a balanced compensating transaction linked to the original. Posted balance is derived from postings. Available balance subtracts active reservations; a reservation is not a final debit. Player funds cannot be overspent, and amounts exposed to JavaScript must fit its exact integer range.

Funds checks, reservation transitions, postings, inbox and outbox are atomic only within Wallet. Internal storage transactions do not become a distributed transaction with Inventory or Shop.

Inventory computes workshop compensation and costs from trusted server rules and freezes them before settlement. Wallet authorizes the initiating integration and operation type; the browser cannot issue arbitrary credits. Existing balances migrate through explicitly labeled opening-balance postings. Do not fabricate historical sales to explain them.

## Identity and UI

Wallet has its own section and history. Inventory presents objects, not currencies or character portraits in place of items. Read models may combine public responses for display, without writing another context's models.

Provider linking proves ownership of the current account and the new external identity. It must not capture an identity attached to another account. Passkey addition must attach to the current player rather than create a second player. Future providers use the same public linking boundary.

## Migration acceptance

`server/internal/domain/inventory`, still used by Inventory pricing, imports the legacy wallet model. Replace this path with the contracts above before calling the new economy complete.

Automated import checks must reject domain/application dependencies on adapters and foreign contexts. Failure tests must interrupt processing after each local commit, restart workers, duplicate and reorder messages, and exercise concurrent commands against the same item/account. Verify no repeated consumption or credit, no negative available balance, balanced postings, conflicting-ID rejection and eventual completion or an observable reconciliation state.
