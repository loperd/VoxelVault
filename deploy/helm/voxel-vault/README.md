# Voxel Vault deployment

The project gateway, private Go API and optional single-node PostgreSQL.

## Public gateway

Ingress targets a separate Overseer Gateway deployment in this release. The API remains
ClusterIP; a NetworkPolicy permits backend traffic only from this release's gateway pods.
The gateway has `SESSION_SECRET`, `INTERNAL_TOKEN` and
`TG_OIDC_CLIENT_SECRET` keys in
`gateway.existingSecret`; it receives no backend database credentials. Provision that
Secret independently, including through the deployment's Vault/VSO workflow if applicable.

The gateway is the shared Overseer Gateway image (`registry.gitlab.com/overseerio/gateway`, tag
`gateway.image.tag`), built by that repository's CI; this chart carries no patched build.

`gateway.config` configures the shared gateway's routes and providers. Telegram OIDC,
access/refresh tokens and cookies belong to the gateway. Internal backend hooks are never
publicly routed. The API verifies the gateway credential, the live Identity session,
current Security permissions and the token's grant ceiling on every protected request.

The API requires explicit `DATABASE_URL`, `IDENTITY_DATABASE_URL`, `SECURITY_DATABASE_URL`,
and `GATEWAY_INTERNAL_TOKEN`, alongside the Inventory/Ledger
runtime connections. `GATEWAY_INTERNAL_TOKEN` matches the gateway's `INTERNAL_TOKEN`, used for
forwarded user requests and `/internal/auth/*` and `/internal/sessions/*` calls. It must be at
least 32 bytes and is not the JWT signing key.
The API selects only its six context credential keys from its Secret and receives no
`SESSION_SECRET` or provider client secret. Gateway and API Secret names must differ.
Ingress without the gateway, public backend Services and a disabled backend NetworkPolicy
are rejected during Helm rendering. Gateway cookie/bearer credentials are stripped before
proxying to the backend. Gateway credentials/provider secrets must be provisioned in
`gateway.existingSecret` independently of API VSO data. Production VSO reads the canonical KV-v2 path
`secret/data/prod/voxel-vault` (API) and `secret/data/prod/voxel-vault/gateway` (gateway only, `secrets.vso.gatewayPath`); the obsolete
`secret/data/voxelvault/gateway/prod` is not consumed. Preserve database credentials when
moving the collection. The Vault policy must allow the project service account to read
the canonical path. Provision context runtime privileges with `/runtime-grants` after
migrations. `SECURITY_POLICY_FILE` contains trusted role definitions;
`IDENTITY_PROVIDERS` limits accepted provider names. Replaying onboarding never restores
a revoked role. Passkey verification is not enabled until provided by the shared gateway.

## Configuration is env — two stores, no `.env` files

| What | Where | Reaches the pod as |
|---|---|---|
| Non-secret config | `env:` in `values*.yaml`, UPPERCASE keys | ConfigMap `<fullname>-env` → `envFrom` |
| Secrets | HashiCorp Vault KV-v2 `secret/<env>/voxel-vault` (`secret/local/voxel-vault`, `secret/prod/voxel-vault`) | Vault Secrets Operator → Secret `voxel-vault-secrets` → `envFrom` |

Values files layer on `values.yaml`:

- `values.local.yaml` — OrbStack on this Mac, local Vault (dev mode), `https://vault.loper.me`.
- `values.prod.yaml` — VPS cluster, `https://voxelvault.mono.place` / `api-voxelvault.mono.place`.

Secret keys (all env): `TELEGRAM_CLIENT_SECRET`, `DATABASE_URL`, `POSTGRES_PASSWORD` (bundled Postgres only).
The API also requires `INVENTORY_DATABASE_URL` and `WALLET_DATABASE_URL` with separate
context runtime credentials. Migration and opening-import credentials belong to the
offline operator process; do not add them to the API Secret.
VSO overwrites the Secret with the KV: fill the KV, the read policy and the Kubernetes-auth role
**before** an install with `secrets.source: vso`.

## Economy context activation

The image contains `/api`, `/wallet-migrate`, `/inventory-migrate`, `/economy-cutover` and
`/workshop-worker`, `/runtime-grants` for explicit runtime permission setup and `/treasury-open`
for a separately authorized opening allocation, and `/account-restrict` (operator `WALLET_DATABASE_URL`:
`add|lift|list` send/receive restrictions).
`/restriction-expire` (run by the `restrictionExpiry` CronJob every 5 minutes with the runtime `WALLET_DATABASE_URL`) publishes `restriction.expired`.
Its default entrypoint remains `/api`; Kubernetes `command` or Docker
`--entrypoint` selects an operator tool. No tool requires a shell in the distroless image.
Helm and the release workflow never run migrations, freeze the source or import balances.

The API runs only the Inventory and Wallet contexts and requires a completed cutover. Startup
checks migrated context databases, a frozen legacy source and both opening baselines matching
its snapshot; if any is missing the process exits (the pod crash-loops and `helm --atomic` rolls
back). Economy endpoints and readiness return 503 only if that check regresses while running.
There is no maintenance mode: the API is down from freeze until import completes, so plan the
window and scale the API to 0 before export.
Rehearse on a controlled copy before the first rollout. With the relevant connections
in the operator environment, run these binaries in order:

```sh
/wallet-migrate
/inventory-migrate
/economy-cutover -action source-migrate
/economy-cutover -action export -source <stable-deployment-id> -manifest /snapshots/economy.json
/economy-cutover -action import -manifest /snapshots/economy.json
/economy-cutover -action import-chests -manifest /snapshots/economy.json
/runtime-grants -context accounts -role <accounts-runtime-role>
/runtime-grants -context inventory -role <inventory-runtime-role>
/runtime-grants -context wallet -role <wallet-runtime-role>
/economy-cutover -action check
```

The operator uses `LEGACY_DATABASE_URL`, `INVENTORY_DATABASE_URL` and `WALLET_DATABASE_URL`.
`CUTOVER_WALLET_ASSETS` explicitly authorizes opening imports. `WALLET_ASSETS` is the API/check
asset allowlist and must contain currency, all rulebook materials and any historical assets
players need to access. `ECONOMY_CONFIG` defaults to the image's bundled rulebook. Mount a
private writable snapshot volume for export and preserve it for resumable imports.

`CUTOVER_INVENTORY_SOURCES` is a separate trusted comma-separated source allowlist for
item/chest imports. It must contain the frozen deployment's source ID. Missing or mismatched
scope denies the import; the combined import checks Inventory authority before changing
Wallet. Offline migration authority is not assigned to API or worker identities.

Export permanently fences legacy economy writes; it is not a dry run. Repeating an export
with the same source identity recovers the stored artifact. Repeating imports uses durable
baseline receipts. `check` only reads schemas and matching baseline receipts, exits nonzero
when activation is incomplete, and prints `{"apiCutoverReady":true}` on success. It shares
the API's startup validations, supports read-only database credentials and never starts workers.
This checks readiness at that instant; it does not replace restore/rollout verification.

Run `runtime-grants` with the corresponding operator connection (`DATABASE_URL` for
transitional Accounts; the context URLs for Inventory and Wallet). Provision dedicated
runtime roles separately: no ownership, role memberships, elevated cluster permissions,
persistent schema/database creation rights or accessible non-system security-definer functions.
The tool applies adapter-owned table/column grants in one local transaction and rejects
excessive effective table/sequence rights, including PUBLIC grants and grant options, in
that database. It does not create roles or grant future tables. The Ledger policy
explicitly revokes the obsolete `DELETE` privilege on `ledger.holds` from the selected
runtime role; holds now transition through status updates. Other unexpected rights,
including rights inherited through PUBLIC, still reject the entire transaction.
Re-run after schema/policy changes. It does not audit other databases or replace
application RBAC and resource authorization. Switch to runtime connections before checking
API startup. The API does not run legacy or Casbin AutoMigrate. RBAC policy data may still be
seeded.

Inventory runtime now requires Goose version 4. Its lifecycle migration records verified
checkpoints for existing instances using Go under local write locks. Runtime Go adapters
append history and update custody in their own transactions. Drain Inventory writers before upgrading; reapply its runtime grants
for the registry/history tables before starting the new API or worker. Imported baselines
are labeled as opening observations, without reconstructing unrecorded historical events.

Ledger runtime requires Goose version 7. The historical `WALLET_DATABASE_URL`,
`wallet-migrate`, `runtime-grants -context wallet` and Goose `wallet_schema_version`
identities are retained; the accounting tables now belong to schema `ledger`.
Migration 7 renames the existing schema without copying or reinterpreting records;
the same migration adds active accounts, immutable transfer quotes, confirmation receipts, account restrictions and the outbox `kind`.

For an existing activated installation, stop API and workshop-worker writers before
running `/wallet-migrate` with operator credentials. Reapply wallet runtime grants
against schema `ledger`, then start only the new Ledger-wired binaries. Do not repeat
opening exports/imports or reset balances for this ownership upgrade. Rehearse the
upgrade and verify pending intents, holds, history and replay receipts on a copy first.
There is no mixed-version writer compatibility window.

`TRANSFER_CONFIG` must reference the currency/commission configuration (the image
bundles `/config/transfers.json`). Include every configured currency in `WALLET_ASSETS`.
Configured fee accounts start empty; startup cannot allocate funds. Group-restricted
configuration requires a membership adapter and fails startup without one; group
administration is outside the current slice.

Player sales use the named `inventory-buyback`
treasury and cannot use currency reward issuance. An empty treasury rejects buyback;
Inventory restores the reserved item after the payout-close fence. Salvage remains a
burn with material output and does not enter the buyback funding path.

After baseline imports, an authorized operator may allocate the approved initial budget:

```sh
/treasury-open -treasury inventory-buyback -asset currency -units <approved-units> \
  -source <allocation-source> -reference <approval-reference>
```

Use a Wallet operator connection, with `TREASURY_OPENING_TREASURIES`,
`TREASURY_OPENING_ASSETS` and canonical positive `TREASURY_OPENING_MAX_UNITS` explicitly
limiting that operator's funding scope. Keep this authority out of API/worker credentials.
The allocation is pinned once per treasury/asset, including its source/reference/amount;
replaying it after spending does not refill the treasury. Changing the allocation conflicts.
Ordinary future replenishment requires a funded transfer, not another opening allocation.
No deployment hook or application startup creates this budget automatically. Complete
imports before funding; funding is ledger activity and later baseline re-imports reject drift.

All domain checks, ledger validation and lifecycle recording execute in Go. Migrations
create storage structures and ordinary integrity constraints without custom PostgreSQL
functions, procedures or triggers. Legacy write fencing is a Go transaction lease taken
by the cutover tooling; no application writer of the legacy economy remains. Drain old API/worker versions and revoke
legacy economy write access before the cutover; unrestricted operator SQL bypasses
application checks. The schema owner remains an offline operator identity.

Inventory application entrypoints independently enforce RBAC and resource scopes through
the Security decision port. User identity comes from the authenticated session; role
assignments are read from transitional Security/Casbin storage for each decision. Workers
and Wallet events have separate service identities and operation-bound permissions.
Startup binds the exact configured starter plan; callers cannot choose a different grant.
HTTP route checks remain an additional compatibility layer. No database procedure or
trigger implements authorization.

Roll out the API only after a successful check and runtime-grant verification, with its context
connections already in the Secret. There is no legacy engine to return to: recovery must move
forward with compatible context code; Helm `--atomic` cannot reverse an imported ledger.
The standalone worker is optional because the context-backed API already runs delivery.

## Local (OrbStack)

```sh
security add-generic-password -a "$USER" -s voxel-vault-telegram -w   # once: the Telegram secret into the Keychain
./deploy/bootstrap/up-local.sh   # Vault + VSO + KV/policy/role, API image, chart (values.local.yaml), checks
npm run dev                                                 # behind the tunnel https://vault.loper.me → :5173
```

Vite proxies `/api` to the cluster Service (`VITE_API_TARGET`; OrbStack resolves `cluster.local` from
macOS) and accepts the tunnel host (`VITE_ALLOWED_HOSTS`). Dev Vault keeps the KV in memory: after
`vault-0` restarts, run the bootstrap again (it keeps the Postgres password from the synced Secret).

## Hosts

| | Development | Production |
|---|---|---|
| Frontend | `https://vault.loper.me` (Cloudflare tunnel → Vite `:5173`) | `https://voxelvault.mono.place` (Cloudflare) |
| API | Vite proxies `/api` to the cluster Service | `https://api-voxelvault.mono.place` (VPS cluster), behind the frontend's `/api/*` |

Passkeys (`WEBAUTHN_RP_ID`), the Telegram redirect and the session cookie belong to the frontend
origin. Telegram rejects `localhost`, hence the tunnel. BotFather: trusted origin = the frontend
origin, redirect URI = `TELEGRAM_REDIRECT_URL`.
