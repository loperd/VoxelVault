/**
 * Stills of block worlds for before/after review, from the real BlockView (world-review.html).
 * No dev server: the page is built into a temporary folder and served to Playwright by page.route.
 *
 *   node scripts/world-review.mjs <out-dir> <name>=<query> [<name>=<query> ...]
 *   node scripts/world-review.mjs artifacts/world-review/baseline deep-mine="world=deep-mine" poc="world=deep-mine&mode=shadow-poc"
 *
 * Writes <out-dir>/<name>.png (1600×900 canvas) and <out-dir>/capture.json (queries, metrics, errors).
 * `--build <dir>` only builds the page into <dir> (for a browser driven from elsewhere, which serves
 * that folder by route the same way).
 * World packs (`<name>=pack=<folder>…`) are served from the repo's packs/, or from `--packs <dir>`
 * (a copy with a file swapped, for a before/after of data alone). A query with `cycles=N` also loads
 * and releases the pack N times and records the counts after each in capture.json.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';

const argv = process.argv.slice(2),
  packsAt = argv.indexOf('--packs');
const packs = resolve(
  packsAt >= 0 ? argv.splice(packsAt, 2)[1] : join(import.meta.dirname, '..', 'packs'),
);
const [out, ...shots] = argv;
if (!out || !shots.length)
  throw new Error(
    'Usage: node scripts/world-review.mjs <out-dir> <name>=<query> ... | --build <dir>',
  );
const root = resolve(import.meta.dirname, '..');
const buildOnly = out === '--build';
const dist = buildOnly
  ? resolve(shots[0])
  : await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'world-review-'));
await build({
  root,
  logLevel: 'warn',
  build: {
    outDir: dist,
    emptyOutDir: true,
    rolldownOptions: { input: { review: join(root, 'world-review.html') } },
  },
});
if (buildOnly) {
  console.log(dist);
  process.exit(0);
}

const TYPES = {
  '.u16': 'application/octet-stream',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
};
// localhost, not a made-up host: packs are hashed with crypto.subtle, which only a secure context has.
const ORIGIN = 'http://localhost';
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const report = { capturedAt: new Date().toISOString(), browser: browser.version(), shots: [] };
try {
  await mkdir(out, { recursive: true });
  // deviceScaleFactor 4/3: BlockView draws at .75 of the device pixels, so the canvas is 1600×900.
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 4 / 3,
    reducedMotion: 'reduce',
  });
  await context.route(`${ORIGIN}/**`, async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = path.startsWith('/packs/')
      ? join(packs, path.slice('/packs/'.length))
      : join(dist, path === '/' ? 'world-review.html' : path);
    try {
      await route.fulfill({
        body: await readFile(file),
        contentType: TYPES[extname(path)] ?? 'application/octet-stream',
      });
    } catch {
      await route.fulfill({ status: 404, body: '' });
    }
  });
  for (const shot of shots) {
    const [name, query] = [shot.slice(0, shot.indexOf('=')), shot.slice(shot.indexOf('=') + 1)];
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('response', (r) => {
      if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
    });
    await page.goto(`${ORIGIN}/world-review.html?${query}`, { waitUntil: 'networkidle' });
    try {
      await page.waitForFunction(() => Boolean(window.review), {}, { timeout: 120000 });
    } catch (error) {
      // The page never got ready: say why (its errors), not only that it timed out.
      throw new Error(`${name}: ${errors.join(' | ') || error.message}`);
    }
    const cycles = Number(new URLSearchParams(query).get('cycles') ?? 0);
    const { png, metrics, pack } = await page.evaluate(
      async (cycles) => ({
        png: await window.review.snapshot(),
        metrics: window.review.metrics(),
        pack: window.review.pack
          ? {
              diagnostics: window.review.pack.diagnostics(),
              ...(cycles ? { cycles: await window.review.pack.cycles(cycles) } : {}),
            }
          : undefined,
      }),
      cycles,
    );
    await writeFile(join(out, `${name}.png`), Buffer.from(png.split(',')[1], 'base64'));
    report.shots.push({ name, query, metrics, ...(pack ? { pack } : {}), errors });
    console.log(`${name}: ${errors.length ? errors.join(' | ') : 'ok'}`);
    await page.close();
  }
  await writeFile(join(out, 'capture.json'), JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await rm(dist, { recursive: true, force: true });
}
