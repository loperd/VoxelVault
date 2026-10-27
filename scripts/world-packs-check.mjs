/**
 * World packs in the REAL game (index.html, production build under a non-empty base): the case's
 * own world, a world pack picked from the screen, its lighting presets, back again, fast switches,
 * a switch while the chest falls, a full opening, leaving and coming back, another case, a reload,
 * a broken pack, and repeated cycles (canvases and JS heap). A pick is for this view of the case
 * only: never stored, gone with the screen, another case or a reload. The API is answered here (a
 * player, a chest of the case and one of another).
 *
 *   node scripts/world-packs-check.mjs <out-dir> [--case ender]
 *
 * Writes <out-dir>/*.png and <out-dir>/report.json; exits 1 if a check failed.
 * Needs Playwright installed outside the repo: `npm i -g playwright && npx playwright install chromium`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

// Playwright is not a dependency of the repo: it lives outside it (`npm i -g playwright`).
const { chromium } = await import('playwright')
  .catch(
    () =>
      import(
        pathToFileURL(
          join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright', 'index.mjs'),
        ).href
      ),
  )
  .catch(() => {
    throw new Error(
      'Playwright is needed outside the repo: npm i -g playwright && npx playwright install chromium',
    );
  });

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : fallback;
};
const caseId = option('--case', 'ender');
const otherCaseId = option('--other-case', 'traveler');
const [out] = argv;
if (!out) throw new Error('Usage: node scripts/world-packs-check.mjs <out-dir> [--case <id>]');
const root = resolve(import.meta.dirname, '..');
const BASE = '/vault/';
const dist = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'world-packs-'));
// vite.config.ts copies packs/ into the build, as for production.
await build({
  root,
  base: BASE,
  logLevel: 'warn',
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
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
};
// localhost: packs are hashed with crypto.subtle, which only a secure context has.
const ORIGIN = 'http://localhost';
const item = (id, rarity) => ({
  id,
  title: `Предмет ${id}`,
  image: 'images/voxel-vault-symbol.png',
  type: rarity,
  chance: 1,
});
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const chest = (status, id = 'check-chest', of = caseId) => ({
  id,
  caseId: of,
  status,
  seed: 7,
  condition: 1,
  traits: [],
  sessionId: undefined,
  contents: RARITIES.map((rarity, i) => ({ weight: 5 - i, item: item(String(i + 1), rarity) })),
});
const API = {
  'api/v1/me': () => ({ id: 'check', handle: 'check', displayName: 'Check', roles: [] }),
  'api/v1/inventory': () => [chest('available'), chest('available', 'other-chest', otherCaseId)],
  'api/v1/inventory/items': () => ({ items: [], balances: {} }),
  // As the server answers: the chest with the session it was claimed for, then opened with a drop.
  'api/v1/inventory/check-chest/claim': ({ sessionId }) => ({
    chest: { ...chest('opening'), sessionId },
  }),
  'api/v1/inventory/check-chest/open': ({ sessionId }) => ({
    chest: {
      ...chest('opened'),
      sessionId,
      drop: { item: item('3', 'rare'), state: 'intact' },
      openedAt: new Date().toISOString(),
    },
  }),
};

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--expose-gc'],
});
const report = {
  capturedAt: new Date().toISOString(),
  browser: browser.version(),
  base: BASE,
  caseId,
  checks: [],
  errors: [],
};
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`,
  );
};

async function open({ broken = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  await context.route(`${ORIGIN}/**`, async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const local = path.startsWith(BASE) ? path.slice(BASE.length) : path.slice(1);
    if (local.startsWith('api/'))
      return API[local]
        ? route.fulfill({ json: API[local](route.request().postDataJSON() ?? {}) })
        : route.fulfill({ status: 404, json: { error: 'not mocked' } });
    if (broken && local === 'packs/sample-ruin/structure.u16')
      return route.fulfill({ status: 404, body: '' });
    try {
      await route.fulfill({
        body: await readFile(join(dist, local === '' ? 'index.html' : local)),
        contentType: TYPES[extname(local)] ?? 'application/octet-stream',
      });
    } catch {
      await route.fulfill({ status: 404, body: '' });
    }
  });
  const page = await context.newPage();
  const packFiles = [];
  page.on('request', (r) => {
    if (r.url().includes('/packs/')) packFiles.push(r.url());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !(broken && r.url().endsWith('structure.u16')))
      errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  await page.goto(`${ORIGIN}${BASE}index.html#/cases/${caseId}/instances/check-chest`, {
    waitUntil: 'networkidle',
  });
  await page.waitForSelector('.world-control summary');
  return { context, page, errors, packFiles };
}

const summary = (page) => page.locator('.world-control summary').innerText();
const settled = (page) =>
  page.waitForFunction(
    () => !document.querySelector('.world-control summary')?.textContent?.includes('загрузка'),
    undefined,
    { timeout: 30_000 },
  );
const panel = async (page) => {
  if (!(await page.locator('.world-control').evaluate((e) => e.open)))
    await page.locator('.world-control summary').click();
};
const environment = async (page, value) => {
  await panel(page);
  await page.locator('.world-control select').first().selectOption(value);
};
const lighting = async (page, value) => {
  await panel(page);
  await page.locator('.world-control select').nth(1).selectOption(value);
};
const canvases = (page) => page.evaluate(() => document.querySelectorAll('canvas').length);
const heap = (page) =>
  page.evaluate(() => {
    globalThis.gc?.();
    return performance.memory?.usedJSHeapSize;
  });
const at = (page, id, instance) =>
  page.evaluate(
    ([id, instance]) => {
      location.hash = `#/cases/${id}/instances/${instance}`;
    },
    [id, instance],
  );
// Nothing of the pick in the browser's storage (the sound setting may be there).
const stored = (page) =>
  page.evaluate(() =>
    Object.keys(localStorage).filter((key) => /environment|lighting|world|pack/i.test(key)),
  );
// Where the world control is, shut and open: clear of the header, the case's text, its right column,
// the open action and the catalogue, and inside the screen.
const box = (page, selector) =>
  page
    .locator(selector)
    .first()
    .evaluate((e) => {
      const r = e.getBoundingClientRect();
      return r.width && r.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    })
    .catch(() => null);
const overlaps = (a, b) =>
  a &&
  b &&
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;
async function placement(page) {
  const { width, height } = page.viewportSize(),
    result = {};
  for (const open of [false, true]) {
    await page.locator('.world-control').evaluate((e, open) => {
      e.open = open;
    }, open);
    const control = await box(page, '.world-control'),
      hits = [];
    for (const selector of [
      '.screen-header',
      '.case-heading',
      '.case-featured',
      '.intro-scene .actions',
      '.intro-scene__catalog',
    ])
      if (overlaps(control, await box(page, selector))) hits.push(selector);
    const inside =
      !!control &&
      control.x >= 0 &&
      control.y >= 0 &&
      control.x + control.width <= width &&
      control.y + control.height <= height;
    result[open ? 'open' : 'shut'] = { hits, inside };
  }
  return result;
}
// Contrast of the interface's text over the world behind it (WCAG): the text hidden for a shot of what
// is behind it, measured at the lighter side of that (90th percentile), against the text's colour.
const TEXTS = {
  nav: '.screen-header__nav > *',
  eyebrow: '.case-heading .eyebrow',
  title: '.case-heading h1',
  description: '.intro-scene__description',
  column: '.case-featured .eyebrow',
  caption: '.case-caption',
};
const luminance = (...rgb) => {
  const [r, g, b] = rgb.map((v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
async function legibility(page) {
  const result = {};
  for (const [name, selector] of Object.entries(TEXTS)) {
    const text = page.locator(selector).first();
    if (!(await text.count()) || !(await text.isVisible())) continue;
    const clip = await text.boundingBox(),
      colour = await text.evaluate((e) => getComputedStyle(e).color);
    await text.evaluate((e) => {
      e.style.visibility = 'hidden';
    });
    const png = await page.screenshot({ clip });
    await text.evaluate((e) => {
      e.style.visibility = '';
    });
    // The page decodes its own shot: any size, no decoder of our own.
    const rgba = await page.evaluate(
      async (src) => {
        const image = await createImageBitmap(await (await fetch(src)).blob()),
          canvas = new OffscreenCanvas(image.width, image.height),
          context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return [...context.getImageData(0, 0, image.width, image.height).data];
      },
      `data:image/png;base64,${png.toString('base64')}`,
    );
    const behind = [];
    for (let i = 0; i < rgba.length; i += 4)
      behind.push(luminance(rgba[i], rgba[i + 1], rgba[i + 2]));
    behind.sort((a, b) => a - b);
    const back = behind[Math.floor(behind.length * 0.9)],
      fore = luminance(
        ...colour
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number),
      );
    result[name] =
      Math.round(((Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05)) * 100) / 100;
  }
  return result;
}
// AA for its size: the title is large text.
const legible = (contrast) =>
  Object.entries(contrast).every(([name, ratio]) => ratio >= (name === 'title' ? 3 : 4.5));
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });

try {
  await mkdir(out, { recursive: true });
  {
    const { context, page, errors, packFiles } = await open();
    await page.waitForTimeout(5000);
    await shot(page, '01-case-world');
    // The case's own world, as a reference: what the pack's are measured beside.
    const caseContrast = await legibility(page);
    const caseCanvases = await canvases(page);
    check(
      "starts in the case's own world",
      (await summary(page)).startsWith('Мир кейса'),
      await summary(page),
    );

    await environment(page, 'sample-ruin');
    await settled(page);
    await page.waitForTimeout(4000);
    await shot(page, '02-sample-ruin');
    check(
      'sample-ruin from the game screen, its own light',
      (await summary(page)) === 'Руины · Свет пака',
      await summary(page),
    );
    const packCanvases = await canvases(page);
    const home = `${ORIGIN}${BASE}packs/sample-ruin/`,
      files = [...new Set(packFiles)];
    check(
      'every file of the pack from under the base',
      files.length > 0 &&
        files.every((url) => url.startsWith(home)) &&
        ['pack.json', 'structure.u16', '.png', '.glb'].every((end) =>
          files.some((url) => url.endsWith(end)),
        ),
      files.map((url) => url.slice(ORIGIN.length)),
    );

    report.contrast = { case: caseContrast };
    for (const [i, name] of [
      'pack',
      'warm-torchlit',
      'cold-moonlight',
      'golden-hour',
      'dark-cinematic',
    ].entries()) {
      await lighting(page, name);
      await page.locator('.world-control').evaluate((e) => {
        e.open = false;
      });
      await page.waitForTimeout(800);
      await shot(page, `03-preset-${i}-${name}`);
      const contrast = (report.contrast[name] = await legibility(page));
      check(`readable over ${name}`, legible(contrast), contrast);
    }
    await lighting(page, 'dark-cinematic');
    check(
      'presets are applied by name',
      (await summary(page)).endsWith('Dark Cinematic'),
      await summary(page),
    );

    // The control's place at several screens, with the longest light name.
    await lighting(page, 'cold-moonlight');
    await page.waitForTimeout(500);
    for (const [width, height] of [
      [1280, 800],
      [1440, 900],
      [1024, 700],
      [900, 700],
      [800, 700],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(500);
      const place = await placement(page);
      await shot(page, `12-place-${width}x${height}-open`);
      check(
        `the control at ${width}x${height}: clear of the case's content, on the screen`,
        Object.values(place).every((p) => p.inside && !p.hits.length),
        place,
      );
    }
    await page.locator('.world-control').evaluate((e) => {
      e.open = false;
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(500);
    await lighting(page, 'pack');
    await page.waitForTimeout(800);
    await shot(page, '04-pack-light-again');
    check(
      "back to the pack's own light",
      (await summary(page)) === 'Руины · Свет пака',
      await summary(page),
    );

    await environment(page, '');
    await page.waitForTimeout(2500);
    await shot(page, '05-case-world-again');
    check(
      "back to the case's world: as many canvases as at first",
      (await canvases(page)) === caseCanvases,
      { now: await canvases(page), first: caseCanvases },
    );

    // A preset belongs to the world it was picked in: the pack comes back in its own light.
    await environment(page, 'sample-ruin');
    await settled(page);
    await lighting(page, 'cold-moonlight');
    await environment(page, '');
    await page.waitForTimeout(300);
    await environment(page, 'sample-ruin');
    await settled(page);
    check(
      'back in the pack: its own light, not the preset picked before',
      (await summary(page)) === 'Руины · Свет пака',
      await summary(page),
    );

    // Fast switches while the pack loads: the last pick wins, nothing stale is shown over it.
    for (let i = 0; i < 6; i++) {
      await environment(page, 'sample-ruin');
      await environment(page, '');
    }
    await environment(page, 'sample-ruin');
    await settled(page);
    await page.waitForTimeout(1500);
    check(
      'fast switches: the last pick shown, one world',
      (await summary(page)) === 'Руины · Свет пака' && (await canvases(page)) === packCanvases,
      { summary: await summary(page), canvases: await canvases(page), expected: packCanvases },
    );
    await shot(page, '06-after-fast-switches');

    // A switch while the chest falls into the pack.
    await environment(page, '');
    await page.waitForTimeout(1500);
    await environment(page, 'sample-ruin');
    await settled(page);
    await page.waitForTimeout(250);
    await environment(page, '');
    await page.waitForTimeout(250);
    await environment(page, 'sample-ruin');
    await settled(page);
    await page.waitForTimeout(4000);
    await shot(page, '07-after-switch-while-falling');

    // Cycles: no canvases or heap pile up.
    const heaps = [];
    for (let i = 0; i < 5; i++) {
      await environment(page, '');
      await page.waitForTimeout(600);
      await environment(page, 'sample-ruin');
      await settled(page);
      await page.waitForTimeout(600);
      heaps.push(await heap(page));
    }
    check("5 cycles: one world's canvases", (await canvases(page)) === packCanvases, {
      canvases: await canvases(page),
      expected: packCanvases,
    });
    report.heap = heaps;
    if (heaps.every(Number.isFinite))
      check(
        '5 cycles: heap does not grow with every cycle',
        heaps[4] < heaps[1] * 1.25,
        heaps.map((h) => Math.round(h / 1e6) + ' MB'),
      );

    // Leaving the screen while the pack loads, and coming back.
    await environment(page, '');
    await page.waitForTimeout(600);
    await environment(page, 'sample-ruin');
    await page.evaluate(() => {
      location.hash = '#/inventory';
    });
    await page.waitForTimeout(1500);
    await at(page, caseId, 'check-chest');
    await page.waitForSelector('.world-control summary');
    await settled(page);
    await page.waitForTimeout(3000);
    check(
      "left while loading and back: the case's world, the pick gone with the screen",
      (await summary(page)).startsWith('Мир кейса') && (await canvases(page)) === caseCanvases,
      { summary: await summary(page), canvases: await canvases(page), expected: caseCanvases },
    );
    await shot(page, '08-back-on-the-screen');

    // Another case in the same App: its own world from the first frame, no pack asked for.
    await environment(page, 'sample-ruin');
    await settled(page);
    await lighting(page, 'golden-hour');
    await page.waitForTimeout(800);
    const packRequests = [];
    const onRequest = (request) => {
      if (request.url().includes('/packs/')) packRequests.push(request.url());
    };
    page.on('request', onRequest);
    const firstSummaries = page.evaluate(
      () =>
        new Promise((done) => {
          // Every text the control shows until the other case settles.
          const seen = [];
          const note = () => {
            const text = document.querySelector('.world-control summary')?.textContent;
            if (text && seen.at(-1) !== text) seen.push(text);
          };
          const watch = new MutationObserver(note);
          watch.observe(document.body, { subtree: true, childList: true, characterData: true });
          setTimeout(() => {
            watch.disconnect();
            done(seen);
          }, 2500);
        }),
    );
    await at(page, otherCaseId, 'other-chest');
    const seen = await firstSummaries;
    await page.waitForTimeout(2000);
    check(
      "another case: the case's world, never the pick of the case before",
      (await summary(page)).startsWith('Мир кейса') &&
        !seen.some((text) => text.startsWith('Руины')) &&
        !packRequests.length,
      { summary: await summary(page), seen, packRequests },
    );
    await shot(page, '08b-other-case');
    await at(page, caseId, 'check-chest');
    await page.waitForSelector('.world-control summary');
    await page.waitForTimeout(2000);
    check(
      'back to the first case: its own world again',
      (await summary(page)).startsWith('Мир кейса') && (await canvases(page)) === caseCanvases,
      { summary: await summary(page), canvases: await canvases(page) },
    );
    page.off('request', onRequest);

    // A reload starts from the case's world; nothing of the pick was stored.
    await environment(page, 'sample-ruin');
    await settled(page);
    await lighting(page, 'warm-torchlit');
    await page.waitForTimeout(500);
    check('the pick is never stored', !(await stored(page)).length, await stored(page));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.world-control summary');
    await page.waitForTimeout(2000);
    check(
      "a reload: the case's world",
      (await summary(page)).startsWith('Мир кейса'),
      await summary(page),
    );

    // The full opening below is in the pack.
    await environment(page, 'sample-ruin');
    await settled(page);
    await page.waitForTimeout(2000);

    // A full opening in the pack: roulette, prize, back to the chest.
    await page.locator('.world-control').evaluate((e) => {
      e.open = false;
    });
    const openButton = page.getByRole('button', { name: 'Открыть сундук', exact: true });
    await openButton.waitFor({ state: 'visible', timeout: 60_000 });
    await openButton.click();
    // The chest opens in the world with the control still there; the roulette covers both.
    await page
      .locator('.roulette--canvas:not([hidden])')
      .waitFor({ state: 'visible', timeout: 60_000 });
    check('the control hides behind the roulette', !(await page.locator('.world-control').count()));
    await page.locator('#prize-title').waitFor({ state: 'visible', timeout: 60_000 });
    check('the control stays hidden on the prize', !(await page.locator('.world-control').count()));
    await shot(page, '09-prize');
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.waitForSelector('.world-control summary', { timeout: 60_000 });
    await settled(page);
    await page.waitForTimeout(3000);
    check(
      'after the prize: the pack again, one world',
      (await summary(page)) === 'Руины · Свет пака' && (await canvases(page)) === packCanvases,
      { summary: await summary(page), canvases: await canvases(page) },
    );
    await shot(page, '10-after-prize');
    report.errors.push(...errors.map((e) => `main: ${e}`));
    check('no errors in the console', !errors.length, errors);
    await context.close();
  }
  {
    const { context, page, errors } = await open({ broken: true });
    await environment(page, 'sample-ruin');
    await settled(page);
    await page.waitForTimeout(3000);
    const status = await page.locator('.world-control [role="status"]').innerText();
    await shot(page, '11-broken-pack');
    check(
      "a broken pack says why and the case's world stands in",
      (await summary(page)).includes('не загрузилось') &&
        /structure\.u16/.test(status) &&
        (await canvases(page)) > 0,
      { summary: await summary(page), status },
    );
    // Back to the case world and nothing else: the pick is only stored.
    await environment(page, '');
    report.errors.push(...errors.map((e) => `broken: ${e}`));
    // Chromium logs the 404 handed out above by itself, without a URL.
    check(
      'broken pack: no errors but the one it reports',
      !errors.filter(
        (e) =>
          !/world pack|structure\.u16|Failed to load resource: the server responded with a status of 404/.test(
            e,
          ),
      ).length,
      errors,
    );
    await context.close();
  }
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await rm(dist, { recursive: true, force: true });
}
if (report.checks.some((c) => !c.ok)) process.exitCode = 1;
