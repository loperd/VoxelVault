# Development and validation

## Frontend

Use Node 24.12+ and npm; `package-lock.json` is the dependency lock.

```sh
npm ci
npm run dev
```

`postinstall`, `predev` and build synchronize Draco from the installed Three.js version and the current Relic runtime asset. Do not copy an unrelated decoder into `public/vendor/draco/`.

Vite proxies `/api` to `VITE_API_TARGET`. A configured tunnel host can be allowed through `VITE_ALLOWED_HOSTS`. The frontend needs a running API for account-backed behavior; isolated rendering previews use their own fixtures.

## API and database

The API module is under `server/`; its entry point is `cmd/api`. Go version requirements are recorded in `server/go.mod`.

```sh
cd server
go run ./cmd/api
```

The API uses PostgreSQL and runs its configured migrations/seed setup on startup. Important environment settings:

| Setting | Purpose |
|---|---|
| `HTTP_ADDRESS` | Listener, default `:8080` |
| `DATABASE_URL` | PostgreSQL connection |
| `FRONTEND_URL` | Frontend origin/base URL |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`, `WEBAUTHN_ORIGINS` | Passkey relying party and allowed origins |
| `COOKIE_SECURE` | Secure session-cookie setting |
| `TELEGRAM_CLIENT_ID`, `TELEGRAM_CLIENT_SECRET`, `TELEGRAM_REDIRECT_URL` | Optional Telegram login |
| `STARTER_CHESTS` | One-time starter stock, `case:count,...` |

Passkeys, the Telegram redirect and session cookies belong to the frontend origin. Telegram development uses a trusted HTTPS tunnel rather than a localhost redirect. Kubernetes configuration and secrets are documented in the [chart](../../deploy/helm/voxel-vault/README.md) and [bootstrap](../../deploy/bootstrap/README.md) guides.

## Checks

```sh
npm test
npm run test:ui
npm run test:physics
npm run typecheck
npm run build
```

`npm run test:all` runs the three test groups. Core tests use Node's TypeScript stripping; this does not replace TypeScript type checking. UI tests compile components and exercise React DOM in Happy DOM. Physics tests load real Rapier WASM. Scene types are checked separately by `typecheck:scene`.

From `server/`:

```sh
go test ./...
go vet ./...
```

Set `TEST_DATABASE_URL` for database integration tests; a skipped database test is not evidence of PostgreSQL behavior. Build and unit tests do not establish browser layout or mobile GPU performance.

## Focused previews

`npm run preview:canvas` serves the isolated roulette at `http://127.0.0.1:4174/canvas-preview.html`. It does not require the full Three.js/Rapier scene. `canvasPreview.stats()` reports CPU submission/frame interval statistics, not GPU execution time.

Vite also serves `/canvas-preview.html`, `/mods-preview.html`, `/breakage-preview.html`, `/scene-lab.html` and `/world-review.html` for the corresponding runtime tools. Review pages are development tools, not evidence that the production screen passed visual review.

## Artifacts

Write generated reports, screenshots and benchmarks under `artifacts/`. Use English headings, captions, filenames and report messages; retain actual localized UI text when recording product evidence. Do not rewrite old test results to imply a new run. Keep model source files and their local README contracts under `assets/chests/`.
