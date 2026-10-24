# Documentation

This is the maintained documentation for Voxel Vault. Source code and executable configuration define current behavior. Documents explicitly label accepted designs that are not implemented yet. Git preserves superseded drafts and session history; they are not duplicated here.

## Product and architecture

- [Product scope and priorities](product.md): experience, remaining work and release expectations.
- [Architecture](architecture/overview.md): layers, ownership and the current migration boundary.
- [Bounded contexts and settlement sagas](architecture/contexts.md): accepted target for Inventory, Wallet, Identity/Profile and Shop.
- [Opening runtime](architecture/opening-runtime.md): authoritative outcomes, presentation, cancellation and recovery.

## Reference

- [Economy](reference/economy.md): chest metadata, rulebook, workshop rules and the current HTTP contract.
- [Chest appearance and breakage](reference/chest-presentation.md): model profiles, overlays and deterministic fragments.
- [World system](worlds/README.md): engine, scene ownership, guests and rendering experiments.
- [World packs](worlds/packs.md): format, validation, resource ownership and review.
- [Minecraft import](worlds/minecraft-import.md): offline conversion and compatibility reporting.

## Operations and authoring

- [Development and validation](guides/development.md)
- [Asset authoring and Blender](guides/asset-authoring.md)
- [Mobile performance](guides/performance.md)
- [Releases](guides/releases.md)
- [0.4.2 release notes](releases/0.4.2.md)
- [0.4.1 release notes](releases/0.4.1.md)
- [0.3.11 release notes](releases/0.3.11.md)
- [0.3.10 release notes](releases/0.3.10.md)

Deployment-specific instructions remain next to their configuration: [bootstrap](../deploy/bootstrap/README.md) and [Helm chart](../deploy/helm/voxel-vault/README.md). The [blockworld package README](../packages/blockworld/README.md) documents the reusable engine.

## Maintenance rules

Keep one authoritative page per topic. Update it when behavior changes rather than adding a dated working-state page. Preserve useful commands, contracts, invariants and known limitations; remove session permissions, obsolete blockers and abandoned implementation sequences. Record test evidence with its scope and date, without presenting an old run as the current release status.

Write documentation, README files and generated report text in English. Store generated captures and reports in `artifacts/`; do not version build outputs or duplicate them in documentation. Historical artifacts remain evidence of their original run and must not be relabeled as fresh results.
