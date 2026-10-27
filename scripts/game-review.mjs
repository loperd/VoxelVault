/**
 * Stills of the REAL game screen — index.html, the case's chest-opening screen with its interface —
 * with an art-lab world behind the chest instead of the case's own, for review only.
 * The page is built into a temporary folder and served to Playwright by page.route; the API is
 * answered here (a player, one available chest of the case); the game's code is not changed: the
 * build alone maps every world id to the art-lab world named by ?world-lab=.
 *
 *   node scripts/game-review.mjs <out-dir> <name>=<art-lab world>@<case id>@<desktop|mobile> ...
 *   node scripts/game-review.mjs artifacts/visual-design/game crypt-desktop=art-crypt-final@traveler@desktop
 *
 * Writes <out-dir>/<name>.png (the whole screen) and <out-dir>/capture.json.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';

const [out, ...shots] = process.argv.slice(2);
if (!out || !shots.length)
  throw new Error(
    'Usage: node scripts/game-review.mjs <out-dir> <name>=<world>@<case>@<desktop|mobile> ...',
  );
const root = resolve(import.meta.dirname, '..');
const VIEWPORTS = {
  desktop: { width: 1600, height: 900, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const WORLDS = join(root, 'src/adapters/outbound/worlds/index.ts');
const BLOCK_WORLDS =
  'export const BLOCK_WORLDS: Partial<Record<WorldId, StageBuilder<ChestHandles>>> = Object.freeze({';

/** Review build only: BLOCK_WORLDS answers every world id with the art-lab world in ?world-lab=. */
const worldLab = {
  name: 'world-lab',
  // Before TypeScript is stripped: the pattern below is the source as written.
  enforce: 'pre',
  transform(code, id) {
    if (id !== WORLDS) return;
    if (!code.includes(BLOCK_WORLDS))
      throw new Error('worlds/index.ts changed: BLOCK_WORLDS not found for the world-lab override');
    return `import { ART_LAB as __ART_LAB } from './art-lab/index.ts';\n${code.replace(
      BLOCK_WORLDS,
      `const __LAB = __ART_LAB[new URLSearchParams(location.search).get('world-lab') ?? ''];\n` +
        `export const BLOCK_WORLDS: Partial<Record<WorldId, StageBuilder<ChestHandles>>> = __LAB ? Object.freeze({ overworld: __LAB, 'deep-mine': __LAB, end: __LAB, dragon: __LAB }) : Object.freeze({`,
    )}`;
  },
};
const dist = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'game-review-'));
await build({
  root,
  logLevel: 'warn',
  plugins: [worldLab],
  build: {
    outDir: dist,
    emptyOutDir: true,
    rolldownOptions: { input: { index: join(root, 'index.html') } },
  },
});

const TYPES = {
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
const ORIGIN = 'http://review.local';
const item = (id, rarity) => ({
  id,
  title: `Предмет ${id}`,
  image: 'images/voxel-vault-symbol.png',
  type: rarity,
  chance: 1,
});
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const api = (caseId) => ({
  '/api/v1/me': { id: 'review', handle: 'review', displayName: 'Review', roles: [] },
  '/api/v1/inventory': [
    {
      id: 'review-chest',
      caseId,
      status: 'available',
      seed: 7,
      condition: 1,
      traits: [],
      contents: RARITIES.map((rarity, i) => ({ weight: 5 - i, item: item(String(i + 1), rarity) })),
    },
  ],
  '/api/v1/inventory/items': { items: [], balances: {} },
});

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const report = { capturedAt: new Date().toISOString(), browser: browser.version(), shots: [] };
try {
  await mkdir(out, { recursive: true });
  for (const shot of shots) {
    const name = shot.slice(0, shot.indexOf('=')),
      [world, caseId, size] = shot.slice(shot.indexOf('=') + 1).split('@');
    const viewport = VIEWPORTS[size];
    if (!world || !caseId || !viewport)
      throw new Error(`Bad shot "${shot}": <name>=<world>@<case>@<desktop|mobile>`);
    const { width, height, ...device } = viewport;
    const context = await browser.newContext({
      viewport: { width, height },
      ...device,
      reducedMotion: 'reduce',
    });
    const answers = api(caseId);
    await context.route(`${ORIGIN}/**`, async (route) => {
      const path = decodeURIComponent(new URL(route.request().url()).pathname);
      if (path.startsWith('/api/'))
        return answers[path]
          ? route.fulfill({ json: answers[path] })
          : route.fulfill({ status: 404, json: { error: 'not mocked' } });
      try {
        await route.fulfill({
          body: await readFile(join(dist, path === '/' ? 'index.html' : path)),
          contentType: TYPES[extname(path)] ?? 'application/octet-stream',
        });
      } catch {
        await route.fulfill({ status: 404, body: '' });
      }
    });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('response', (r) => {
      if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
    });
    await page.goto(
      `${ORIGIN}/index.html?world-lab=${encodeURIComponent(world)}#/cases/${caseId}/instances/review-chest`,
      { waitUntil: 'networkidle' },
    );
    // The chest falls and settles; the screen is still after that.
    await page.waitForTimeout(8000);
    await page.screenshot({ path: join(out, `${name}.png`) });
    report.shots.push({ name, world, caseId, size, errors });
    console.log(`${name}: ${errors.length ? errors.join(' | ') : 'ok'}`);
    await context.close();
  }
  await writeFile(join(out, 'capture.json'), JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await rm(dist, { recursive: true, force: true });
}
