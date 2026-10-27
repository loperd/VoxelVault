# Economy reference

This page describes the implemented chest economy and its rulebook. [Context boundaries](../architecture/contexts.md) defines the accepted replacement for the existing coupled wallet/workshop path. Numeric values are starting balance settings, not fixed domain constants; read the current `server/config/economy.json` for exact values.

## Model and authority

The server issues, owns and persists chest instances, rolls landing/opening outcomes and merges instances. The client validates and renders these results.

A chest type defines its title, collection/world, model, item pool, contents count and eligible traits. An instance records `id`, `owner`, type, rulebook revision, seed, frozen contents, traits, rarity, condition, origin and lifecycle state. Each content slot has a distinct item and weight. A trait has an ID, intensity in `(0,1]` and seed; its definition supplies groups, tiers and policy.

An owned item is a separate instance with ID, item definition, condition (`intact`, `slight`, `heavy`, `broken`) and origin. A drop reference on a chest is not a substitute for the owned item.

Lifecycle: an available chest is claimed for one session, progresses through opening, and ends opened or destroyed. Merging consumes two available instances of the same type and produces a new instance referencing both parents. Terminal instances cannot be opened again. Repeating a successful claim/open for the same session returns its prior outcome.

## Contents, rarity and condition

Contents are sampled without replacement from the type's weighted pool when issued. The starting design uses eight distinct slots per instance, with item rarities common/uncommon/rare/epic/legendary and initial pool weights 40/25/15/8/4. Pool sizes and weights are configuration, not assumptions the UI may hardcode.

Chest rarity is the highest rarity R for which the proportion of slots with rarity at least R meets the configured threshold (initially 30%). It counts items rather than their roll weights: 20% epic plus 20% legendary qualifies as epic. A rare item with a low roll weight still counts as one slot. Traits may modify the sampled contents before rarity is assessed.

Each damage/aging trait contributes wear to the model parts it covers. Part wear is the capped sum of contributions; overall condition is one minus the worst part's wear. Weather and End traits need not reduce integrity. Display condition as remaining integrity, not as drop probability.

## Traits

Trait definitions contain `id`, group, intensity tier thresholds, optional variants, issue frequency, condition contribution, merge policy, exclusivity group, eligible types and loot effects. Starting tier thresholds are 0.3, 0.6 and 0.85.

| Group | Examples | Starting issue policy | Merge policy |
|---|---|---|---|
| Damage | body/lid cracks, scuffs, latch rust/patina | 50%, one or two traits | Reset |
| Aging | moss, cobweb, vines, glow lichen | 20%, one trait | Keep |
| Weather | snow, frost | 10%, one trait | Keep; mutually exclusive |
| End | void runes, end crystals, end blight | 3%, eligible Ender/Dragon types | Keep and possibly upgrade |

Starting keep chances for aging/weather are 40% if present on one parent and 85% on both; End uses 20%/70%. Shared traits have an initial 25% upgrade chance. End tiers may replace common contents with additional rare-or-better items. These policies are implemented through the rulebook rather than frontend rendering effects.

Merging unions the two contents sets and samples the configured number uniformly. It does not preferentially retain rare items. Rarity is reassessed, damage resets, and retained aging may leave the resulting chest imperfect.

## Landing and opening

Claim determines landing damage and destruction at impact. Open determines overload destruction first, then selects the drop if the chest survives. The client cannot report a winning collision or declare destruction through a separate endpoint.

The relevant parameters include `landing.damage.chance`, `landing.damage.intensity.max`, `landing.trait.<id>.weight`, `chest.destroy.impact.perWear` and `chest.destroy.opening.perWear`. A destroyed chest has no drop and records its destruction moment. [Chest presentation](chest-presentation.md) explains how those outcomes are drawn.

For surviving openings, starting item-damage chance is wear × 0.6. Conditional damaged-state proportions are `slight = 1 − 0.7w`, `heavy = 0.5w`, `broken = 0.2w`, where `w` is wear. This formula never grants a drop from a chest already destroyed.

## Workshop rules

The server quotes actions from the same formulas used to perform them. The client must not calculate authoritative prices or submit an arbitrary credit amount.

Starting item base values by rarity are 4/8/16/32/64. State multipliers are 1/0.75/0.5/0.25 for intact/slight/heavy/broken. Amounts are whole units.

- Repair: only damaged items; spend the item's base value in its collection material to improve one state step.
- Salvage: consume the item for base × state multiplier in its collection material.
- Sale: consume the item for base × state multiplier × `item.sellRate` (initially 2.5) in common currency.
- Merge items: consume two different damaged instances of the same item; retain the better one, with a configurable chance (initially 70%) to improve it by one step.

Inventory reserves the item and Ledger settles the funds through a durable saga, with its own double-entry book; see [contexts](../architecture/contexts.md).

## Rulebook configuration

`server/internal/inventory/domain/rulebook` holds the pure model. `server/internal/rulebookjson` decodes the JSON configuration and rejects unknown fields. The API reads `ECONOMY_CONFIG` on startup; the default is `config/economy.json` and the container uses `/config/economy.json`.

A parameter has a default and conditional rules. Conditions may refer to type, collection, trait, item state, issue source, time and named events. Rules can set, multiply, add, allow or deny. More-specific `set` rules win, with explicit priority as the tie breaker; values are constrained to valid ranges. Collection/type defaults use the same conditional mechanism rather than separate inheritance.

Published configuration has a revision. Issued contents, traits and derived rarity/condition are frozen until a chest event changes them. Landing/merge reassessment and action-time prices use the applicable current rulebook. Rulebook reload, administration, player statistics/pity inputs and a configuration simulator require their own implementation and validation; they are not implied by the format.

## Current HTTP contract

Responses contain server decisions. Ownership failures do not reveal another player's objects. Routes are registered in `contextRoutes` (`server/internal/httpapi/contexts.go`); every economy route answers 503 while the cutover readiness guard fails. Mutations marked "key" require an `Idempotency-Key` header (1–160 characters); a repeat with the same key answers the same result.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/v1/inventory` | — | Chest instances; first access grants configured starter stock once |
| `POST /api/v1/inventory/{id}/claim` | `{sessionId}` | `{chest, landing}`; landing may be null for a repeat |
| `POST /api/v1/inventory/{id}/open` | `{sessionId}` | `{chest, item}`; item is null when destroyed |
| `GET /api/v1/inventory/merge?a=&b=` | — | Merge odds `{traits[{id,keep,upgrade}], contents{total,kept,keep}}` in percent |
| `POST /api/v1/inventory/merge` | key, `{a, b}` | New chest, HTTP 201 |
| `GET /api/v1/inventory/items` | — | `{items}`; items carry status, optional `operationId` and current offers |
| `POST /api/v1/inventory/items/{id}/repair` | key | HTTP 202, operation, `Location: /api/v1/inventory/operations/{operationId}` |
| `POST /api/v1/inventory/items/{id}/salvage` | key | HTTP 202, operation, `Location` as above |
| `POST /api/v1/inventory/items/{id}/sell` | key | HTTP 202, operation, `Location` as above |
| `GET /api/v1/inventory/operations/{id}` | — | Operation `{operationId, itemId, action, stage, version, quote, reason?}` |
| `POST /api/v1/inventory/operations/{id}/cancel` | — | HTTP 202, operation |
| `POST /api/v1/inventory/items/merge` | key, `{a, b}` | Retained owned item |
| `GET /api/v1/wallet` | — | `{balances[{asset, posted, held, available}], currencies[{asset, name, code, precision, canOperate}]}`; amounts are decimal strings |
| `GET /api/v1/wallet/transactions?asset=&cursor=&limit=` | — | `{entries[{id, asset, direction, units, purpose, reference, status, at?}], nextCursor?}`; asset defaults to `currency`, limit 1–100 (default 25) |
| `GET /api/v1/wallet/recipient?asset=&query=` | Exact handle or stable ID | `{id, handle, displayName}`; recipient must have currency access |
| `POST /api/v1/wallet/quotes` | `{asset, recipient, units}`; exact minimum-unit string | Immutable quote, HTTP 201; 60-second expiry, fees, debit and receipt |
| `POST /api/v1/wallet/transfers` | key, `{quoteId}` | Committed `{transferId, journalId, currencyId, state, debitUnits, receiptUnits}`; safe to retry with the same key |
| `POST /api/v1/admin/users/{userId}/chests` | key, `{caseId, count}` | `{userId, caseId, issued}`, HTTP 201 |
| `GET /api/v1/cases/{type}/catalog` | — | Type item pool and weight shares |

Workshop actions settle asynchronously through the Inventory–Ledger saga: insufficient funds cancel the operation rather than fail the request. Poll the operation until its stage is final, then reread items and wallet.

Chest DTOs include `id`, `caseId`, status, seed (exact, as a string), revision, rarity, condition, `contents[{item,weight}]`, `traits[{id,intensity,seed}]`, origin, optional session/drop/destruction moment/opening time. Owned items include item definition, instance state and origin. Offers carry amounts as `{resource, value}` with `value` a decimal string: optional repair, salvage, sale, optional selected merge partner and merge-repair chance. An item removed from the rulebook may remain listed without offers.

`chance` in catalog/display DTOs is the server-provided weight share for the relevant pool or contents. It does not authorize client-side selection or issuance. Merge odds describe trait keep/upgrade and how many distinct contents survive; the same server plan drives execution.

Transaction history includes active holds and released holds alongside committed journal entries. Status is explicit: `held`, `captured`, `credited` or `released`. Capturing a hold replaces its pending row with the committed debit; it does not display two money movements. Held/released amounts have no debit/credit sign in Wallet. Recorded event timestamps are used for holds; when a legacy hold has no recorded timestamp, `at` is omitted. Holds and journals share owner-bound pagination.

Internal transfer confirmation is synchronous: success means all Ledger postings committed. `TRANSFER_CONFIG` selects administrator-owned currency and commission configuration; the bundled 1% inside tax is an example, not a fixed economic rule. Amounts use `int64` minimum units and currency-specific precision (0–18); legacy `currency` remains precision 0. An uncommitted expired quote returns 409 `quote_expired`; insufficient available funds returns 409 `insufficient_funds`.

Errors are `{error: code}` (`contextError` in `server/internal/httpapi/contexts.go`): 400 `invalid`, 403 `forbidden`, 404 `not_found` (missing or unowned), 409 `conflict` or `not_ready` (incompatible state, session conflict, invalid merge pair), 503 otherwise. Malformed bodies and missing keys answer 400 before reaching the contexts.


## Transfer boundary hardening

Recipient lookup accepts exact safe identifiers. Legacy Telegram-derived `tg_<id>` handles
are not lookup keys; own profiles and recipient resolution expose an opaque `u_<account-id>`
handle instead, preserving stored account IDs and historical records. Control and invisible
formatting characters are rejected at Identity input/read boundaries and again in the Wallet
adapter; confirmation isolates recipient text with `bdi`.

A completed quote still checks whether the confirmation key belongs to a different quote.
Unused keys on completed-quote replay do not create command rows. Generic settlement
producers cannot use the reserved `user-transfer` namespace. Fee account provisioning
requires the canonical treasury account identity.

Inactive accounts reject new reserve/capture/credit/payout movement. Cancel/close commands
can still release existing holds. Read-only receipts and owned history remain available;
no operation silently reactivates an account. Wallet history combines Ledger owner checks
with Currency read eligibility, retaining historical rows and holdings after revocation.
A quote priced under another currency access revision or fee rule version is refused at confirmation with 409 `quote_expired`; nothing is reserved.

HTTP transfer routes use per-user/route counters in a fixed global minute window. Window
rotation drops the old map in constant time; this is a per-process limiter, not a distributed
quota. Persisted quote caps independently limit created rows per second and per day
(`Limits.QuotesPerSecond`/`QuotesPerDay` in `TRANSFER_CONFIG`, no code defaults; bundled 3 and 2000)
per sender, including expired/completed quotes, and return HTTP 429 `rate_limited`. The per-route HTTP limiter numbers are `Limits.RecipientRequestsPerMinute`/`QuoteRequestsPerMinute`/`TransferRequestsPerMinute` (bundled 10/30/30).
A quote for a blocked sender or recipient is refused at quote time as well as at confirmation. Records
are retained; these are write-rate limits, not a fixed lifetime storage bound.

### Account restrictions

`ledger.account_restrictions` holds `send` and `receive` blocks (a frozen account has both).
Rows are never deleted; a block is effective from `created_at` until the earlier of
`expires_at` and `lifted_at`. The API runtime role has only SELECT and INSERT on it, so a
compromised API cannot lift a block; lifting is an operator action that records `lifted_by`.
Confirmation checks both accounts while holding their locks. A sender block returns 403; a
receive block applies to user-to-user transfers only and the sender sees the neutral
`not_found`. Quotes taken before a block are refused at confirmation.

More than `Limits.TransfersPerMinute` confirmed transfers in a minute rejects the next one
with 429 `rate_limited` and writes a time-limited `send` block of `Limits.SuspendMinutes`
(never indefinite, one active auto-block per account). Operators add, lift and list
restrictions with `/account-restrict` (see the Helm README); there is no appeal flow.

Restriction changes are published through the generic outbox (`internal/platform/outbox`, table `ledger.outbox`, topic `account-restrictions`) as `restriction.added`, `restriction.lifted` and `restriction.expired`. They are written in the same transaction as the change (auto-blocks included); expiry has no write of its own, so the `restriction-expire` CronJob publishes it. Event ids are `restriction:<id>:<kind>`, so each fact exists once. The body holds ids, kind, `expiresAt` and actor, never the internal reason. A consumer reads the topic with `Table.Topic("account-restrictions", "")` and must deduplicate by id; Ledger's receipt queues ignore these events (`kind` filter). No consumer ships yet.
