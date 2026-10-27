/**
 * The roulette on the REAL game screen (production build served by page.route, mocked API, the server's own item art) at the
 * seven review viewports: screenshots of every phase plus measured geometry.
 *
 *   node scripts/roulette-review.mjs <out-dir> [<viewport>]
 *
 * Asserts: no horizontal page overflow; the stopped prize card's centre (found in the canvas pixels,
 * between the transparent gaps) is within 2 CSS px of the pointer's centre; the reward screen shows
 * the server's prize and its Close button fits the screen; the same holds with reduced motion and
 * after a resize in the middle of a spin. A damaged prize shows its state; a destroyed chest shows no
 * roulette and promises no reward. Writes <out-dir>/<viewport>-<phase>.png and report.json.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';

const out = resolve(process.argv[2] ?? 'artifacts/roulette-v2');
const only = process.argv[3]; // optional: one viewport name, e.g. 390x844
const root = resolve(import.meta.dirname, '..');
const VIEWPORTS = [
  [390, 844, true],
  [1100, 950],
  [1280, 800],
  [1440, 900],
  [1512, 945],
  [1600, 1000],
  [1920, 1080],
]
  .map(([width, height, mobile]) => ({
    name: `${width}x${height}`,
    width,
    height,
    mobile: Boolean(mobile),
  }))
  .filter((viewport) => !only || viewport.name === only);

// The server's item art: the same SVG silhouettes as server/internal/httpapi/item_image.go.
const go = await readFile(join(root, 'server/internal/httpapi/item_image.go'), 'utf8');
const shapes = Object.fromEntries(
  [...go.matchAll(/^\s*"(\w+)":\s*`([^`]*)`/gm)].map((match) => [match[1], match[2]]),
);
const economy = JSON.parse(await readFile(join(root, 'server/config/economy.json'), 'utf8'));
const pool = economy.types.find((type) => type.id === 'traveler').pool;
const WEIGHTS = { common: 40, uncommon: 25, rare: 12, epic: 5, legendary: 2 };
const dto = (item) => ({
  id: item.id,
  title: item.title,
  type: item.rarity,
  chance: WEIGHTS[item.rarity],
  image: `/api/v1/items/${item.id}/image.svg?v=2`,
});
const svg = (item) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img"><g stroke-linejoin="miter">${shapes[item.glyph] ?? shapes.crystal}</g></svg>`;

// No local port: the build is answered by page.route (sandboxes may forbid listening).
const dist = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'roulette-review-'));
await build({
  root,
  logLevel: 'warn',
  build: {
    outDir: dist,
    emptyOutDir: true,
    rolldownOptions: { input: { index: join(root, 'index.html') } },
  },
});
const origin = 'https://review.local';
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
};
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const report = { capturedAt: new Date().toISOString(), browser: browser.version(), runs: [] };
await mkdir(out, { recursive: true });

/** One opening, start to reward. `winner` is what the server decides; the page must only show it. */
async function run({
  viewport,
  winner,
  reducedMotion = false,
  resizeTo,
  label,
  state = 'intact',
  destroyed = false,
}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.mobile ? 3 : 2,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
  });
  const chest = {
    id: 'review-0',
    caseId: 'traveler',
    status: 'available',
    seed: 7,
    condition: 1,
    traits: [],
    contents: pool.map((item) => ({ item: dto(item), weight: WEIGHTS[item.rarity] })),
  };
  await context.route(`${origin}/**`, async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (!path.startsWith('/api/')) {
      try {
        return await route.fulfill({
          body: await readFile(join(dist, path === '/' ? 'index.html' : path)),
          contentType: TYPES[extname(path)] ?? 'application/octet-stream',
        });
      } catch {
        return route.fulfill({ status: 404, body: '' });
      }
    }
    const art = path.match(/^\/api\/v1\/items\/([^/]+)\/image\.svg$/);
    if (art)
      return route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: svg(pool.find((item) => item.id === art[1]) ?? {}),
      });
    let answer;
    if (path === '/api/v1/me')
      answer = { id: 'review', handle: 'review', displayName: 'Review', roles: [] };
    else if (path === '/api/v1/inventory') answer = [chest];
    else if (path === '/api/v1/inventory/items') answer = { items: [], balances: {} };
    else if (path.endsWith('/catalog')) answer = pool.map(dto);
    else if (/^\/api\/v1\/inventory\/review-0\/(claim|open)$/.test(path)) {
      chest.sessionId = route.request().postDataJSON().sessionId;
      if (path.endsWith('claim')) chest.status = 'opening';
      else if (destroyed) Object.assign(chest, { status: 'destroyed', destroyedAt: 'opening' });
      else
        Object.assign(chest, {
          status: 'opened',
          drop: { item: dto(winner), state },
          openedAt: new Date().toISOString(),
        });
      answer = { chest };
    }
    await route.fulfill({
      status: answer ? 200 : 404,
      json: answer ?? { error: `Unmocked ${path}` },
    });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const result = {
    label,
    viewport: viewport.name,
    winner: destroyed ? undefined : winner.title,
    rarity: winner.rarity,
    state,
    destroyed,
    reducedMotion,
    resizeTo: resizeTo?.name,
    errors,
  };
  const shot = (name) => page.screenshot({ path: join(out, `${label}-${name}.png`) });
  try {
    await page.goto(`${origin}/index.html#/cases/traveler/instances/review-0`, {
      waitUntil: 'load',
    });
    const open = page.getByRole('button', { name: 'Открыть сундук', exact: true });
    await open.waitFor({ state: 'visible', timeout: 60_000 });
    await page.waitForTimeout(800);
    await open.click();
    if (destroyed) {
      await page.locator('.prize--destroyed').waitFor({ state: 'visible', timeout: 60_000 });
      await page.waitForTimeout(900);
      await shot('3-destroyed');
      result.destroyedText = await page.locator('.prize--destroyed').innerText();
      result.rouletteShown = (await page.locator('.roulette--canvas:not([hidden])').count()) > 0;
      result.overflowReward = await overflow(page);
      await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
      await page.locator('#prize-title').waitFor({ state: 'detached', timeout: 60_000 });
      result.reopenOffered = true;
      return result;
    }
    await page
      .locator('.roulette--canvas:not([hidden])')
      .waitFor({ state: 'visible', timeout: 60_000 });
    const started = Date.now();
    if (!reducedMotion) {
      await page.waitForTimeout(1600);
      if (resizeTo) await page.setViewportSize({ width: resizeTo.width, height: resizeTo.height });
      await shot('1-spin');
      result.overflowSpinning = await overflow(page);
    }
    await page.getByText('Награда выбрана', { exact: true }).waitFor({ timeout: 60_000 });
    result.spinSeconds = (Date.now() - started) / 1000;
    // Measured at once: the stopped strip is held only briefly before the reward screen.
    result.alignment = await alignment(page);
    await shot('2-stopped');
    result.overflowStopped = await overflow(page);
    await page.locator('#prize-title').waitFor({ state: 'visible', timeout: 60_000 });
    await page.waitForTimeout(900);
    await shot('3-reward');
    result.prizeTitle = await page.locator('#prize-title').innerText();
    result.conditionText = (await page.locator('.prize__condition').count())
      ? await page.locator('.prize__condition').innerText()
      : undefined;
    const close = page.getByRole('button', { name: 'Закрыть', exact: true });
    const box = await close.boundingBox(),
      size = page.viewportSize();
    result.closeInView = Boolean(
      box &&
      box.y >= 0 &&
      box.y + box.height <= size.height &&
      box.x >= 0 &&
      box.x + box.width <= size.width,
    );
    result.overflowReward = await overflow(page);
    await close.click();
    await page.locator('#prize-title').waitFor({ state: 'detached', timeout: 60_000 });
    result.reopenOffered = true;
  } catch (error) {
    errors.push(String(error));
  } finally {
    await context.close();
    report.runs.push(result);
  }
  return result;
}

const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** The stopped card is the opaque run of canvas pixels under the pointer, bounded by transparent gaps. */
const alignment = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('.roulette--canvas'),
      pointer = document.querySelector('.roulette-pointer');
    const box = canvas.getBoundingClientRect(),
      mark = pointer.getBoundingClientRect();
    const pointerX = mark.left + mark.width / 2;
    const context = canvas.getContext('2d'),
      ratio = canvas.width / box.width;
    const row = Math.round(canvas.height / 2),
      data = context.getImageData(0, row, canvas.width, 1).data;
    const opaque = (x) => data[x * 4 + 3] > 8;
    let x = Math.round((pointerX - box.left) * ratio),
      left = x,
      right = x;
    if (!opaque(x)) return { pointerX, error: 'the pointer is over a gap' };
    while (left > 0 && opaque(left - 1)) left--;
    while (right < canvas.width - 1 && opaque(right + 1)) right++;
    const cardX = box.left + (left + right + 1) / 2 / ratio;
    return {
      pointerX,
      cardX,
      cardWidth: (right - left + 1) / ratio,
      delta: Math.abs(cardX - pointerX),
      pointerY: mark.top + mark.height / 2,
      canvasY: box.top + box.height / 2,
    };
  });

const rarities = ['legendary', 'rare', 'epic', 'uncommon', 'common', 'rare', 'legendary'];
const pick = (rarity) => pool.find((item) => item.rarity === rarity);
try {
  for (const [index, viewport] of VIEWPORTS.entries()) {
    const result = await run({ viewport, winner: pick(rarities[index]), label: viewport.name });
    console.log(
      `${viewport.name}: Δ=${result.alignment?.delta?.toFixed(2)}px overflow=${result.overflowStopped} reward="${result.prizeTitle}" ${result.errors.join('; ')}`,
    );
  }
  if (!only) {
    for (const viewport of [VIEWPORTS[0], VIEWPORTS[3]]) {
      const result = await run({
        viewport,
        winner: pick('epic'),
        reducedMotion: true,
        label: `${viewport.name}-reduced`,
      });
      console.log(
        `${viewport.name} reduced motion: Δ=${result.alignment?.delta?.toFixed(2)}px reward="${result.prizeTitle}" ${result.errors.join('; ')}`,
      );
    }
    const result = await run({
      viewport: VIEWPORTS[3],
      resizeTo: VIEWPORTS[0],
      winner: pick('rare'),
      label: '1440x900-resized-390x844',
    });
    console.log(
      `resize mid-spin: Δ=${result.alignment?.delta?.toFixed(2)}px reward="${result.prizeTitle}" ${result.errors.join('; ')}`,
    );
  }
  for (const viewport of [VIEWPORTS[0], VIEWPORTS.at(-1)]) {
    const damaged = await run({
      viewport,
      winner: pick('epic'),
      state: 'heavy',
      label: `${viewport.name}-damaged`,
    });
    console.log(
      `${viewport.name} damaged: Δ=${damaged.alignment?.delta?.toFixed(2)}px reward="${damaged.prizeTitle}" condition="${damaged.conditionText}" ${damaged.errors.join('; ')}`,
    );
    const broken = await run({
      viewport,
      winner: pick('epic'),
      destroyed: true,
      label: `${viewport.name}-destroyed`,
    });
    console.log(
      `${viewport.name} destroyed: roulette=${broken.rouletteShown} ${broken.errors.join('; ')}`,
    );
  }
} finally {
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await rm(dist, { recursive: true, force: true });
}

const failures = report.runs.flatMap((run) =>
  run.destroyed
    ? [
        ...run.errors.map((error) => `${run.label}: ${error}`),
        ...(run.rouletteShown ? [`${run.label}: a destroyed chest spun the roulette`] : []),
        ...(/Ваша награда/.test(run.destroyedText ?? '')
          ? [`${run.label}: a destroyed chest promises a reward`]
          : []),
        ...(run.overflowReward > 0 ? [`${run.label}: horizontal overflow`] : []),
        ...(run.reopenOffered ? [] : [`${run.label}: Close does not leave the outcome screen`]),
      ]
    : [
        ...run.errors.map((error) => `${run.label}: ${error}`),
        ...(run.state !== 'intact' && !run.conditionText
          ? [`${run.label}: the damaged prize does not show its state`]
          : []),
        ...(run.alignment?.delta <= 2
          ? []
          : [`${run.label}: prize card ${JSON.stringify(run.alignment)} is not under the pointer`]),
        ...([run.overflowSpinning, run.overflowStopped, run.overflowReward].some(
          (value) => value > 0,
        )
          ? [`${run.label}: horizontal overflow`]
          : []),
        ...(run.prizeTitle === run.winner
          ? []
          : [`${run.label}: reward "${run.prizeTitle}" is not the server's "${run.winner}"`]),
        ...(run.closeInView ? [] : [`${run.label}: the Close button is off screen`]),
        ...(run.reopenOffered ? [] : [`${run.label}: Close does not leave the outcome screen`]),
      ],
);
assert.deepEqual(failures, [], failures.join('\n'));
console.log(`OK: ${report.runs.length} openings`);
