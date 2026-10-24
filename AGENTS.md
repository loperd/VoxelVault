# Repository instructions

## Communication

Communicate with the user in Russian. Keep replies short: outcome and next step, without recapping the work or repeating the request. Use one-line progress updates. Provide detailed explanations, tables and reviews only when requested; put long reports in a file and link to it with one to three lines of context.

## Documentation and temporary work

Do not expand `docs/` with working notes, plans, investigations, audits, progress reports, session handoffs or generated artifacts. Write all such intermediate material under the temporary `.ai/` directory.

Maintained documentation is distilled from `.ai/` after the findings or decisions are verified. Update and consolidate the existing documentation page for the topic rather than adding another document. Add a new page under `docs/` only when the user explicitly requests one. Keep `docs/` concise and structured; do not copy temporary reports into it wholesale.

Write documentation, README files and artifact/report text in English. This language rule does not change the Russian conversation with the user.

## Releases

Cut every release as described in [docs/guides/releases.md](docs/guides/releases.md): a `release/v<version>` branch merged into master, the tag only on master.

## Database architecture

Implement business rules, lifecycle transitions, authorization, audit recording and ledger
validation in Go application/domain code. Do not create PostgreSQL stored procedures,
custom functions or triggers, including in migrations or test fixtures. Keep persistence
adapters explicit; use local transactions, locks and ordinary integrity constraints for storage.

## Authorization boundaries

Enforce deny-by-default authorization at bounded-context application entrypoints through
context-owned ports. Require authenticated identity, explicit permission and resource scope
for users, services and operators; HTTP middleware alone is insufficient. Never take roles,
permissions or trusted scope from request bodies. Keep cross-context decisions behind
published contracts/adapters and validate actual ownership/state within the local context.

## Reusable foundations

Build application and infrastructure mechanisms for reuse across bounded contexts.
Keep policy evaluation, identity provisioning and configuration loading independent of
concrete features; express feature-specific choices as composition data and adapters.
Keep domain models and invariants owned by their contexts rather than sharing them
through a generic application or infrastructure layer.

## Pre-release replacement

This is a single-user, pre-release product. Replace and remove obsolete implementations
directly. Do not introduce compatibility shims, legacy adapters, fallback stores or
dual-write paths unless the user explicitly requests compatibility. Code replacement
does not authorize deleting or resetting player data.

## Public gateway

Reuse Overseer Gateway for external authentication and edge infrastructure rather than
building OAuth/OIDC servers per backend. Deploy a separate project instance inside this
Helm release. Public ingress targets the gateway; backends remain ClusterIP services with
network access restricted to the gateway. Keep identity mapping/preferences in their own
context and enforce domain RBAC/ownership through context ports. Authenticate the gateway
hop before trusting forwarded identity; request headers alone confer no permissions.

## CodeGraph

If a `.codegraph/` directory exists at the repository root, use CodeGraph before grep/find or reading files to understand or locate code. Prefer the `codegraph_explore` MCP tool when available, or run `codegraph explore "<symbols or question>"`. Include a file or symbol in the query to read current source and call paths.

If `.codegraph/` does not exist, skip CodeGraph. Indexing is the user's decision.
