/**
 * Art direction for a world pack's light, from the real BlockView (lighting-lab.html): every
 * variant shown in one page and one view — the same geometry, materials and camera, only the light
 * switched — and photographed, measured and laid out side by side.
 *
 *   node scripts/lighting-lab.mjs <out-dir> [--pack sample-ruin] [--packs <dir>] [--chest ender] [--camera hero] <variant> ...
 *   node scripts/lighting-lab.mjs artifacts/lighting/ruin warm-torchlit cold-moonlight golden-hour dark-cinematic
 *   node scripts/lighting-lab.mjs artifacts/lighting/try --chest ender golden-hour lighting/variants/ruin-dusk-*.json
 *
 * A variant is a preset's name (the library's or the pack's), `pack` (the pack's own light), or a
 * JSON file — a complete preset or `{ "base": "<name>", …changes }`, no code. Writes per variant
 * <name>.png (1600×900) and, for all of them, sheet.png (up to four, 2×2 at 800×450 each),
 * report.json and report.md: relight time, frame time, draw calls, and what each picture shows
 * (brightness, crushed blacks, clipped whites, warmth, the main object against the frame).
 * Packs are served from the repo's packs/ or `--packs <dir>`.
 *
 * Needs Playwright installed outside the repo: `npm i -g playwright && npx playwright install chromium`.
 *
 * By hand: `npm run dev`, then /lighting-lab.html?pack=sample-ruin&chest=ender (the page's own header
 * lists its parameters and panel). Its JSON, exported and loaded, is the lighting preset contract
 * (packages/blockworld/src/lighting-preset.ts, readLightingPreset): a complete preset, or
 * `{ "base": "<library or pack preset>", …changes, "name" }`, objects merged key by key, anything
 * else replaced, every problem reported; the lab writes it as src/dev/lighting-json.ts says.
 *
 * `--timing <rounds>`: also switch between the named variants `rounds` times and time each switch as
 * it is seen (relight, then the first frame drawn and read back), check that the first frame after a
 * switch is the new light (not blank, not the old one), and what the renderer and the heap hold
 * before and after: timing.json, and a section in report.md. `--gpu`: a visible Chromium on the
 * machine's GPU instead of headless SwiftShader. `--project <file.json>`: `{ "name": [x, y, z] }`
 * points in the pack's frame, written to report.json as where they are on the picture (0..1).
 *
 * `--scenario <preset>`: instead of variants, what a person does in the panel, step by step, each
 * step photographed: the pack's own light; the preset chosen; three settings changed; Export JSON
 * (the file saved); Reset; a fresh page, the file loaded; a wrong file (its problems shown, the light
 * kept); back to the pack's own light; then everything closed. Checks that the loaded file shows
 * exactly the saved light (the preset and the picture), Reset the preset's, the way back the pack's,
 * the chest's lights changed and never added to, and nothing of the pack left alive: scenario.json,
 * scenario.md and sheet.png.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
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
const packs = resolve(option('--packs', join(import.meta.dirname, '..', 'packs')));
const pack = option('--pack', 'sample-ruin'),
  chest = option('--chest'),
  camera = option('--camera');
const rounds = Number(option('--timing', 0)),
  project = option('--project'),
  scenario = option('--scenario');
const gpu = argv.includes('--gpu') && Boolean(argv.splice(argv.indexOf('--gpu'), 1));
const [out, ...variants] = argv;
if (!out || (!variants.length && !scenario))
  throw new Error(
    'Usage: node scripts/lighting-lab.mjs <out-dir> [--pack <folder>] [--packs <dir>] [--chest <case>] [--camera <name>] <preset name | pack | file.json> ...',
  );

const presets = await Promise.all(
  variants.map(async (variant) =>
    variant.endsWith('.json')
      ? { name: basename(variant, '.json'), json: JSON.parse(await readFile(variant, 'utf8')) }
      : { name: variant, json: variant === 'pack' ? null : variant },
  ),
);

const root = resolve(import.meta.dirname, '..');
const dist = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'lighting-lab-'));
await build({
  root,
  logLevel: 'warn',
  build: {
    outDir: dist,
    emptyOutDir: true,
    rolldownOptions: { input: { lab: join(root, 'lighting-lab.html') } },
  },
});

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
// localhost: packs are hashed with crypto.subtle, which only a secure context has.
const ORIGIN = 'http://localhost';
// gc and precise heap sizes: for the timing's before and after.
const flags = ['--js-flags=--expose-gc', '--enable-precise-memory-info'];
/** The built page and the packs, from the disk. */
const serve = async (route) => {
  const path = decodeURIComponent(new URL(route.request().url()).pathname);
  const file = path.startsWith('/packs/')
    ? join(packs, path.slice('/packs/'.length))
    : join(dist, path === '/' ? 'lighting-lab.html' : path);
  try {
    await route.fulfill({
      body: await readFile(file),
      contentType: TYPES[extname(path)] ?? 'application/octet-stream',
    });
  } catch {
    await route.fulfill({ status: 404, body: '' });
  }
};
const browser = await chromium.launch(
  gpu
    ? { headless: false, args: flags }
    : {
        headless: true,
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...flags],
      },
);
const report = {
  capturedAt: new Date().toISOString(),
  browser: browser.version(),
  gpu,
  pack,
  chest: chest ?? null,
  camera: camera ?? null,
  variants: [],
};
try {
  await mkdir(out, { recursive: true });
  // deviceScaleFactor 4/3: BlockView draws at .75 of the device pixels, so the canvas is 1600×900.
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 4 / 3,
    reducedMotion: 'reduce',
  });
  await context.route(`${ORIGIN}/**`, serve);
  if (scenario) {
    await runScenario(context, scenario);
    process.exit(0);
  }
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  const query = new URLSearchParams({
    capture: '',
    pack,
    ...(chest ? { chest } : {}),
    ...(camera ? { camera } : {}),
  });
  await page.goto(`${ORIGIN}/lighting-lab.html?${query}`, { waitUntil: 'networkidle' });
  try {
    await page.waitForFunction(() => Boolean(window.lab), {}, { timeout: 120000 });
  } catch (error) {
    throw new Error(errors.join(' | ') || error.message);
  }

  report.conditions = await page.evaluate(() => window.lab.conditions());
  if (project)
    report.projected = await page.evaluate(
      (points) =>
        Object.fromEntries(
          Object.keys(points).map((name, i, names) => [
            name,
            window.lab.project(names.map((n) => points[n]))[i],
          ]),
        ),
      JSON.parse(await readFile(project, 'utf8')),
    );
  const pictures = [];
  for (const { name, json } of presets) {
    const shot = await page
      .evaluate((json) => {
        const applied = window.lab.apply(json);
        return {
          applied,
          frameMs: window.lab.frameMs(30),
          png: window.lab.snapshot(),
          stats: window.lab.stats(),
          metrics: window.lab.metrics(),
        };
      }, json)
      .catch((error) => ({ error: String(error) }));
    if (shot.error) {
      report.variants.push({ name, error: shot.error });
      console.log(`${name}: ${shot.error}`);
      continue;
    }
    await writeFile(join(out, `${name}.png`), Buffer.from(shot.png.split(',')[1], 'base64'));
    pictures.push({ name, png: shot.png });
    const { drawCalls, triangles } = shot.metrics;
    report.variants.push({
      name,
      preset: shot.applied.name,
      relightMs: +shot.applied.ms.toFixed(2),
      firstFrameMs: +shot.applied.firstFrameMs.toFixed(2),
      frameMs: +shot.frameMs.toFixed(2),
      drawCalls,
      triangles,
      ...shot.stats,
    });
    console.log(
      `${name}: relight ${shot.applied.ms.toFixed(1)} ms, frame ${shot.frameMs.toFixed(2)} ms, luminance ${shot.stats.meanLuminance}, focus ${shot.stats.focusLuminance}`,
    );
  }
  // Up to four side by side, labelled: the comparison sheet.
  const sheet = await page.evaluate(async (pictures) => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 1600, height: 900 }),
      g = canvas.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, 1600, 900);
    g.font = '600 22px system-ui';
    await Promise.all(
      pictures.slice(0, 4).map(
        ({ name, png }, i) =>
          new Promise((done) => {
            const image = new Image();
            image.onload = () => {
              const x = (i % 2) * 800,
                y = Math.floor(i / 2) * 450;
              g.drawImage(image, x, y, 800, 450);
              g.fillStyle = '#000b';
              g.fillRect(x + 8, y + 8, g.measureText(name).width + 16, 32);
              g.fillStyle = '#fff';
              g.fillText(name, x + 16, y + 32);
              done();
            };
            image.src = png;
          }),
      ),
    );
    return canvas.toDataURL('image/png');
  }, pictures);
  await writeFile(join(out, 'sheet.png'), Buffer.from(sheet.split(',')[1], 'base64'));
  if (rounds > 0) {
    const names = presets
      .filter((p) => typeof p.json === 'string' || p.json === null)
      .map((p) => p.json);
    report.timing = await page.evaluate(
      ([names, rounds]) => ({
        ...window.lab.timing(names, rounds),
        checks: names.map((to, i) =>
          window.lab.switchCheck(names[(i + names.length - 1) % names.length], to),
        ),
      }),
      [names, rounds],
    );
    await writeFile(join(out, 'timing.json'), JSON.stringify(report.timing, null, 2));
  }
  report.errors = errors;
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  const rows = report.variants.map((v) =>
    v.error
      ? `| ${v.name} | error: ${v.error} |`
      : `| ${v.name} | ${v.relightMs} | ${v.firstFrameMs} | ${v.frameMs} | ${v.drawCalls} | ${v.meanLuminance} | ${(v.crushedBlack * 100).toFixed(1)}% | ${(v.clippedWhite * 100).toFixed(2)}% | ${v.warmth} | ${v.focusLuminance} | ${v.focusToFrame} | ${v.focusContrast} |`,
  );
  await writeFile(
    join(out, 'report.md'),
    [
      `# Lighting: ${pack}${chest ? ` with ${chest}` : ''}`,
      '',
      `Captured ${report.capturedAt}, ${report.browser}, ${report.conditions.renderer}${gpu ? " (the machine's GPU)" : ' (SwiftShader: times are CPU-side and relative, not a GPU or phone measurement)'}.`,
      '',
      `Fixed: camera ${report.conditions.camera.name} at ${report.conditions.camera.position.map((v) => +v.toFixed(2))} → ${report.conditions.camera.target.map((v) => +v.toFixed(2))}, fov ${report.conditions.camera.fov}, canvas ${report.conditions.canvas.join('×')}, time 0, seed 11, pack ${report.conditions.packHash.slice(0, 12)}${chest ? `, guest ${chest} in ACES at exposure 1.1 × the preset's` : ''}. Only the light changes.`,
      '',
      '| variant | relight ms | first frame ms | frame ms | draws | luminance | crushed black | clipped white | warmth R/B | focus lum. | focus/frame | focus contrast |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
      ...rows,
      '',
      ...(report.timing ? timingRows(report.timing) : []),
      errors.length ? `Errors: ${errors.join(' | ')}` : 'No page errors.',
      '',
    ].join('\n'),
  );
  console.log(`${join(out, 'sheet.png')}${errors.length ? `; errors: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  await rm(dist, { recursive: true, force: true });
}

/** The panel used as a person uses it; see `--scenario`. */
async function runScenario(context, start) {
  const errors = [],
    steps = [],
    checks = [];
  let pages = 0;
  const open = async () => {
    const page = await context.newPage();
    pages++;
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    const query = new URLSearchParams({
      pack,
      ...(chest ? { chest } : {}),
      ...(camera ? { camera } : {}),
    });
    await page.goto(`${ORIGIN}/lighting-lab.html?${query}`, { waitUntil: 'networkidle' });
    try {
      await page.waitForFunction(
        () => Boolean(window.lab) && Boolean(document.querySelector('.panel select')),
        {},
        { timeout: 120000 },
      );
    } catch (error) {
      throw new Error(errors.join(' | ') || error.message);
    }
    return page;
  };
  const state = (page) => page.evaluate(() => window.lab.state());
  const shot = async (page, name) => {
    const png = await page.evaluate(() => window.lab.snapshot());
    await writeFile(
      join(out, `${steps.length}-${name}.png`),
      Buffer.from(png.split(',')[1], 'base64'),
    );
    const { name: preset, problems } = await state(page),
      lights = await page.evaluate(() => window.lab.chestLights());
    steps.push({ step: name, page: pages, preset, problems, chestLights: lights[0] ?? null, png });
    return png;
  };
  /** Mean absolute difference per channel, 0..255. */
  const differ = (page, a, b) =>
    page.evaluate(
      async ([a, b]) => {
        const pixels = (src) =>
          new Promise((done) => {
            const image = new Image();
            image.onload = () => {
              const g = Object.assign(document.createElement('canvas'), {
                width: image.width,
                height: image.height,
              }).getContext('2d');
              g.drawImage(image, 0, 0);
              done(g.getImageData(0, 0, image.width, image.height).data);
            };
            image.src = src;
          });
        const [x, y] = await Promise.all([pixels(a), pixels(b)]);
        let sum = 0;
        for (let i = 0; i < x.length; i += 4)
          sum +=
            Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]);
        return +(sum / ((x.length / 4) * 3)).toFixed(4);
      },
      [a, b],
    );
  const check = (what, ok, detail) => {
    checks.push({ what, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${what}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`,
    );
  };
  const settle = (page) => page.waitForTimeout(250);
  /** A control of the panel by its group and label, set as a person would: its value, then an input event. */
  const set = (page, group, label, value) =>
    page.evaluate(
      ([group, label, value]) => {
        let inGroup = false;
        for (const element of document.querySelector('.panel .controls').children) {
          if (element.tagName === 'H3') {
            inGroup = element.textContent === group;
            continue;
          }
          if (inGroup && element.querySelector('span')?.textContent === label) {
            const input = element.querySelector('input');
            input.value = String(value);
            input.dispatchEvent(new Event('input'));
            return;
          }
        }
        throw new Error(`No control "${group} / ${label}"`);
      },
      [group, label, value],
    );

  await mkdir(out, { recursive: true });
  let page = await open();
  const own = await shot(page, 'pack-light');
  const ownLights = steps[0].chestLights;
  await page.selectOption('.panel select[title=Preset]', start);
  await settle(page);
  const chosen = await shot(page, start);
  check(`${start} chosen`, (await state(page)).name === start);
  check(
    'the preset changes the picture',
    (await differ(page, own, chosen)) > 1,
    await differ(page, own, chosen),
  );
  await set(page, 'Overall', 'Exposure', 1.45);
  await set(page, 'Shadows', 'Darkest level', 0.12);
  await set(page, 'Main light on objects & chest', 'Strength', 4.2);
  await settle(page);
  const edited = await shot(page, 'edited'),
    editedPreset = (await state(page)).preset;
  check(
    'the edits are in the preset shown',
    editedPreset.exposure === 1.45 &&
      editedPreset.ambient.level === 0.12 &&
      editedPreset.key.strength === 4.2,
  );
  check(
    'and in the picture',
    (await differ(page, chosen, edited)) > 1,
    await differ(page, chosen, edited),
  );
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const file = join(out, (await download).suggestedFilename());
  await (await download).saveAs(file);
  const saved = await readFile(file, 'utf8');
  check(
    "the export is a change of the preset (the contract's { base, … })",
    JSON.parse(saved).base === start,
    JSON.parse(saved),
  );
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await settle(page);
  const reset = await shot(page, 'reset');
  check(
    'Reset: the preset again, exactly',
    (await differ(page, chosen, reset)) === 0,
    await differ(page, chosen, reset),
  );
  await page.close();

  page = await open();
  await page.fill('.panel textarea', saved);
  await page.getByRole('button', { name: 'Load JSON', exact: true }).click();
  await settle(page);
  const reloaded = await shot(page, 'loaded');
  const loaded = (await state(page)).preset;
  check(
    'the loaded file is the saved preset',
    JSON.stringify({ ...loaded, name: 0 }) === JSON.stringify({ ...editedPreset, name: 0 }),
    loaded.name,
  );
  check(
    'and shows the saved light, exactly',
    (await differ(page, edited, reloaded)) === 0,
    await differ(page, edited, reloaded),
  );
  // A fresh page, a fresh chest: the same light, by other objects.
  const unnamed = (list) => JSON.stringify(list?.map(({ uuid, ...l }) => l));
  check(
    'the chest lit the same',
    unnamed(steps.at(-1).chestLights) ===
      unnamed(steps.find((s) => s.step === 'edited').chestLights),
  );
  const other = (await page.evaluate(() => window.lab.conditions())).camera.name,
    names = await page.evaluate(() =>
      [...document.querySelectorAll('.panel select[title=Camera] option')].map((o) => o.value),
    );
  const away = names.find((name) => name !== other);
  if (away) {
    const alive = await page.evaluate(() => window.lab.alive());
    await page.selectOption('.panel select[title=Camera]', away);
    await page.waitForFunction((name) => window.lab.conditions().camera.name === name, away);
    await settle(page);
    const moved = await shot(page, `camera-${away}`);
    check(
      `camera ${away}: the loaded light kept, the chest taken in again`,
      steps.at(-1).preset === loaded.name &&
        steps.at(-1).chestLights?.length === steps.at(-2).chestLights?.length &&
        (await differ(page, reloaded, moved)) > 1,
    );
    await page.selectOption('.panel select[title=Camera]', other);
    await page.waitForFunction((name) => window.lab.conditions().camera.name === name, other);
    await settle(page);
    const returned = await shot(page, `camera-${other}`);
    check(
      `back to camera ${other}: the same picture, exactly`,
      (await differ(page, reloaded, returned)) === 0,
      await differ(page, reloaded, returned),
    );
    const after = await page.evaluate(() => window.lab.alive());
    check(
      'the closed views left nothing of the pack alive',
      JSON.stringify(after) === JSON.stringify(alive),
      { before: alive, after },
    );
  }
  await page.fill(
    '.panel textarea',
    JSON.stringify({ base: start, name: 'wrong', bloom: 2, fog: { near: 80, far: 10 } }),
  );
  await page.getByRole('button', { name: 'Load JSON', exact: true }).click();
  await settle(page);
  const wrong = await shot(page, 'wrong-file');
  check(
    'a wrong file: every problem shown',
    steps.at(-1).problems.length >= 2,
    steps.at(-1).problems,
  );
  check(
    'and the light kept',
    (await differ(page, reloaded, wrong)) === 0 && steps.at(-1).preset === loaded.name,
  );
  await page.selectOption('.panel select[title=Preset]', '');
  await settle(page);
  const back = await shot(page, 'pack-light-again');
  check(
    "back to the pack's own light, exactly",
    (await differ(page, own, back)) === 0,
    await differ(page, own, back),
  );
  if (chest) {
    const counts = steps.map((s) => s.chestLights.length);
    check("the chest's lights: as many after every switch", new Set(counts).size === 1, counts);
    // One chest scene per page: its lights are the same objects there; a fresh page has its own chest.
    const ids = [...new Set(steps.map((s) => s.page))].map(
      (n) =>
        new Set(
          steps.filter((s) => s.page === n).map((s) => s.chestLights.map((l) => l.uuid).join()),
        ).size,
    );
    check(
      'the very same light objects of each chest scene after every relight and camera change: none made, none dropped',
      ids.every((n) => n === 1),
      ids,
    );
    check(
      'and set by each light',
      new Set(steps.map((s) => JSON.stringify(s.chestLights.map(({ uuid, ...l }) => l)))).size > 2,
    );
    check(
      "the chest in the pack's light as it came",
      unnamed(steps.at(-1).chestLights) === unnamed(ownLights),
    );
  }
  if (chest) {
    // While it moves: the chest held in the air sways on the case screen; switches between its frames.
    const moving = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      deviceScaleFactor: 4 / 3,
      reducedMotion: 'no-preference',
    });
    await moving.route(`${ORIGIN}/**`, serve);
    const live = await moving.newPage();
    live.on('pageerror', (e) => errors.push(String(e)));
    await live.goto(
      `${ORIGIN}/lighting-lab.html?${new URLSearchParams({ capture: '', pack, chest, ...(camera ? { camera } : {}) })}`,
      { waitUntil: 'networkidle' },
    );
    await live.waitForFunction(() => Boolean(window.lab), {}, { timeout: 120000 });
    const counts = [];
    for (const name of ['warm-torchlit', 'cold-moonlight', null, 'dark-cinematic', start]) {
      await live.evaluate((name) => window.lab.apply(name), name);
      await live.waitForTimeout(120);
      counts.push((await live.evaluate(() => window.lab.chestLights()))[0].length);
    }
    const strip = (list) => list.map(({ uuid, ...l }) => l);
    const lights = strip((await live.evaluate(() => window.lab.chestLights()))[0]),
      still = strip(steps.find((s) => s.step === start).chestLights);
    check(
      'switched while the chest moves: lit as when it is still',
      JSON.stringify(lights) === JSON.stringify(still),
      {
        moving: lights.filter((l) => l.type !== 'PointLight'),
        still: still.filter((l) => l.type !== 'PointLight'),
      },
    );
    check('and as many lights after every switch', new Set(counts).size === 1, counts);
    const closed = await live.evaluate(() => window.lab.close());
    check(
      'closed while moving: nothing alive',
      closed.assets === 0 && closed.resources === 0 && closed.instances === 0,
      closed,
    );
    await moving.close();
  }
  if (chest) {
    // Four views of one pack side by side, four presets, a chest scene in each: each lit by its own view.
    const grid = await context.newPage();
    grid.on('pageerror', (e) => errors.push(String(e)));
    await grid.goto(
      `${ORIGIN}/lighting-lab.html?${new URLSearchParams({ capture: '', grid: '', pack, chest, ...(camera ? { camera } : {}) })}`,
      { waitUntil: 'networkidle' },
    );
    await grid.waitForFunction(() => Boolean(window.lab), {}, { timeout: 120000 });
    const each = await grid.evaluate(() => window.lab.chestLights());
    await writeFile(
      join(out, 'grid.png'),
      Buffer.from((await grid.evaluate(() => window.lab.sheet())).split(',')[1], 'base64'),
    );
    check(
      "four views, four chests: each its own light objects, lit by its own view's preset",
      each.length === 4 &&
        new Set(each.flat().map((l) => l.uuid)).size === each.flat().length &&
        new Set(each.map((list) => JSON.stringify(list.map(({ uuid, ...l }) => l)))).size === 4,
    );
    const closed = await grid.evaluate(() => window.lab.close());
    check(
      'four views closed: nothing alive',
      closed.assets === 0 && closed.resources === 0 && closed.instances === 0,
      closed,
    );
    await grid.close();
  }
  const left = await page.evaluate(() => window.lab.close());
  check(
    'closed: nothing of the pack alive',
    left.assets === 0 && left.resources === 0 && left.instances === 0,
    left,
  );
  check('no page errors', errors.length === 0, errors);
  await page.close();

  const sheetPage = await context.newPage();
  await sheetPage.goto(`${ORIGIN}/lighting-lab.html`).catch(() => {});
  const picks = ['pack-light', start, 'edited', 'loaded'].map((name) =>
    steps.find((s) => s.step === name),
  );
  const sheetPng = await sheetPage.evaluate(
    async (pictures) => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 1600, height: 900 }),
        g = canvas.getContext('2d');
      g.font = '600 22px system-ui';
      await Promise.all(
        pictures.map(
          ({ step, png }, i) =>
            new Promise((done) => {
              const image = new Image();
              image.onload = () => {
                const x = (i % 2) * 800,
                  y = Math.floor(i / 2) * 450;
                g.drawImage(image, x, y, 800, 450);
                g.fillStyle = '#000b';
                g.fillRect(x + 8, y + 8, g.measureText(step).width + 16, 32);
                g.fillStyle = '#fff';
                g.fillText(step, x + 16, y + 32);
                done();
              };
              image.src = png;
            }),
        ),
      );
      return canvas.toDataURL('image/png');
    },
    picks.map(({ step, png }) => ({ step, png })),
  );
  await writeFile(join(out, 'sheet.png'), Buffer.from(sheetPng.split(',')[1], 'base64'));
  const result = {
    pack,
    chest: chest ?? null,
    camera: camera ?? null,
    start,
    saved: JSON.parse(saved),
    checks,
    steps: steps.map(({ png, ...s }) => s),
    errors,
  };
  await writeFile(join(out, 'scenario.json'), JSON.stringify(result, null, 2));
  await writeFile(
    join(out, 'scenario.md'),
    [
      `# Lighting Lab scenario: ${pack}${chest ? ` with ${chest}` : ''}, from ${start}`,
      '',
      ...checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.what}`),
      '',
    ].join('\n'),
  );
  if (checks.some((c) => !c.ok)) {
    await browser.close();
    process.exit(1);
  }
  await browser.close();
  await rm(dist, { recursive: true, force: true });
}

/** The timing as report.md shows it: per variant the median and worst of its switches, the first-frame checks, memory before and after. */
function timingRows(timing) {
  const by = new Map();
  for (const s of timing.switches) by.set(s.name, [...(by.get(s.name) ?? []), s]);
  const median = (list) => {
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  return [
    '## Switching',
    '',
    '| to | switches | relight ms (median / max) | first frame ms (median / max) | total ms (median / max) |',
    '|---|---|---|---|---|',
    ...[...by].map(([name, list]) => {
      const col = (key) =>
        `${median(list.map((s) => s[key]))} / ${Math.max(...list.map((s) => s[key]))}`;
      return `| ${name ?? 'pack'} | ${list.length} | ${col('relightMs')} | ${col('firstFrameMs')} | ${col('totalMs')} |`;
    }),
    '',
    'The first frame after a switch (mean absolute difference per channel, 0..255): against the settled picture, and against the picture before the switch.',
    '',
    '| from → to | first vs settled | first vs before | first frame brightness |',
    '|---|---|---|---|',
    ...timing.checks.map(
      (c) =>
        `| ${c.from ?? 'pack'} → ${c.to ?? 'pack'} | ${c.firstVsSettled} | ${c.firstVsOld} | ${c.firstMeanLuminance} |`,
    ),
    '',
    `Renderer before: ${timing.before.geometries} geometries, ${timing.before.textures} textures; after ${timing.switches.length} switches: ${timing.after.geometries}, ${timing.after.textures}. JS heap${timing.collected ? ' after a collection' : ' (no collection could be asked for)'}: ${timing.before.heap ? `${(timing.before.heap / 1e6).toFixed(1)} MB before, after each round ${timing.heapByRound.map((h) => (h / 1e6).toFixed(1)).join(', ')} MB` : 'not measured'}.`,
    '',
  ];
}
