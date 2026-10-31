# Product scope and priorities

Individual chest instances, rather than chest types, are the units of ownership and opening. The inventory is the main workspace; the case catalog and opened/destroyed archive are separate views.

## Current foundation

The application has a Go API for authentication, chest ownership, authoritative opening outcomes and owned items. The frontend presents per-instance contents and appearance, a physical chest-opening sequence, a roulette strip and the resulting item. World/model definitions are shared by the opening scene and previews.

Inventory shows owned items with server-priced repair, merge, salvage and sale actions (`server/inventory/adapters/rulebook`). Currency and collection materials live in a separate Wallet section backed by the double-entry ledger (`server/ledger`). Inventory settles through the `inventoryledger` integration using durable sagas, outbox/inbox, idempotency and compensation, as the [context contract](architecture/contexts.md) requires. The ledger and Inventory database tests, including race runs, pass against a real PostgreSQL.

## Accepted next work

Identity/Profile needs a settings page for adding passkeys, linking or rebinding Telegram, language and interface preferences. Provider linking must preserve the current player account and be extensible to future Google authentication. Existing login support does not mean these settings are implemented.

The performance target includes iPhone X/11 and midrange Android devices. Chromium CPU/viewport emulation is useful regression evidence but cannot establish Safari, Telegram WebView or physical GPU performance.

## Further product work

Server-side Minecraft account linking and delivery acknowledgment need an explicit integration contract. A reward screen alone does not establish delivery to Minecraft. Future Shop pricing, payment sources and purchase policies require their own domain decisions.

Other planned capabilities include collection progress, discovery/duplicate indicators, account preferences, operational observability and configuration simulation. Do not present speculative mechanics or fabricated activity as existing product behavior.

## Acceptance

Changes must preserve authoritative rewards, prevent repeated consumption or credit, recover interrupted sessions and release rendering resources. UI interactions need real-browser review; performance needs device measurements; a release needs successful CI deployment and a production smoke check. See the [validation](guides/development.md), [performance](guides/performance.md) and [release](guides/releases.md) guides.
