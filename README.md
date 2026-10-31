# Voxel Vault

A Minecraft-themed chest-opening application for server communities. The repository name is `mcroulette`.

The frontend uses React, TypeScript, Vite, Three.js, Canvas 2D and Rapier. The Go API owns chest outcomes and player inventory, backed by PostgreSQL. Domain rules and application ports are separated from UI, storage and rendering adapters.

## Development

Use Node 24.12 or later (see `.nvmrc`).

```sh
npm ci
npm run dev
```

For the API, database, authentication and deployment setup, see the [development guide](docs/guides/development.md).

## Validation

```sh
npm run test:all
npm run build
```

Run `go test ./...` and `go vet ./...` from `server/` for backend changes. Database integration tests need `TEST_WALLET_DATABASE_URL`, a connection that may create disposable databases. A successful build does not establish mobile performance or deployment success.

## Documentation

Start with the [documentation index](docs/README.md). It separates current implementation, accepted architecture and planned work.

- [Product scope and priorities](docs/product.md)
- [Architecture and context boundaries](docs/architecture/overview.md)
- [Economy rules and HTTP contract](docs/reference/economy.md)
- [Rendering and world packs](docs/worlds/README.md)
- [Mobile performance](docs/guides/performance.md)
- [Release procedure](docs/guides/releases.md)

Model sources and their authoring notes live under `assets/chests/`. Generated screenshots, benchmarks and review sheets go under the ignored `artifacts/` directory. Documentation, README files and generated report text are written in English; product localization is a separate concern.

License: GPL-3.0-or-later. See [LICENSE](LICENSE).
