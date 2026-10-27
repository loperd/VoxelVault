/** Run in an environment capable of starting Chromium/WebGL.
 * node scripts/chests/capture-relic-runtime.mjs
 * Captures the development page using the real production asset loader.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const version = process.argv.includes('--v4') ? 'v4' : 'v3';
const optimized = process.argv.includes('--optimized');
const folder = (version === 'v4' ? 'relic-v4' : 'relic-v3-pbr') + (optimized ? '-runtime' : '');
const output = new URL(
  version === 'v4'
    ? '../../artifacts/relic-v4/runtime/'
    : '../../artifacts/relic-pbr-pass/runtime/',
  import.meta.url,
);
await mkdir(output, { recursive: true });
const asset = await readFile(new URL(`../../assets/chests/${folder}/relic.glb`, import.meta.url));
const assetSha256 = createHash('sha256').update(asset).digest('hex');
const externalUrl = process.env.RELIC_REVIEW_URL;
let browser,
  server,
  stage = 'server';
const errors = [],
  shots = [],
  loadedAssets = [];
try {
  await writeFile(
    new URL('validation.json', output),
    JSON.stringify({ passed: false, status: 'running', assetSha256 }, null, 2),
  );
  if (!externalUrl) {
    server = await createServer({ server: { host: '127.0.0.1', port: 4186, strictPort: true } });
    await server.listen();
  }
  stage = 'browser';
  const executablePath =
    process.env.CHROME_EXECUTABLE ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined);
  browser = await chromium.launch({ executablePath, headless: true, timeout: 15_000 });
  stage = 'page';
  const page = await browser.newPage({
    viewport: { width: 1300, height: 1000 },
    deviceScaleFactor: 1,
  });
  page.on('response', (response) => {
    if (response.url().includes(`/assets/chests/${folder}/relic.glb`)) {
      loadedAssets.push(
        response
          .body()
          .then((body) => createHash('sha256').update(body).digest('hex'))
          .catch((error) => {
            errors.push(`Runtime asset response failed: ${String(error)}`);
            return null;
          }),
      );
    }
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const reviewUrl = new URL(externalUrl ?? 'http://127.0.0.1:4186/relic-review.html');
  if (optimized) reviewUrl.searchParams.set('optimized', '1');
  await page.goto(reviewUrl.href);
  const ready = (which) =>
    page.waitForFunction(
      (asset) => window.relicReview?.status().ready && window.relicReview.status().asset === asset,
      which,
    );
  await ready('v4');
  async function capture(name) {
    await page.evaluate(() => window.relicReview.render());
    await page.locator('canvas').screenshot({ path: new URL(`${name}.png`, output).pathname });
    shots.push({
      file: `${name}.png`,
      status: await page.evaluate(() => window.relicReview.status()),
    });
  }
  await page.selectOption('#asset', version === 'v4' ? 'after' : 'before');
  await ready(version === 'v4' ? 'after' : 'before');
  await capture('01-before');
  await page.selectOption('#asset', version === 'v4' ? 'v4' : 'after');
  await ready(version === 'v4' ? 'v4' : 'after');
  await capture('02-after');
  await page.click('#clay');
  await capture('03-clay');
  await page.click('#clay');
  await page.selectOption('#rig', 'showcase');
  await capture('04-showcase');
  await page.selectOption('#rig', 'neutral');
  await page.click('#front');
  await capture('05-front');
  await page.click('#top');
  await capture('06-top');
  await page.click('#three');
  await page.click('#open');
  await capture('07-open');
  await page.click('#open');
  await page.selectOption('#rig', 'app');
  await capture('08-application-lights');
  if (version === 'v4') {
    await page.selectOption('#rig', 'weak');
    await capture('09-weak-emission-on');
    await page.click('#emission');
    await capture('10-weak-emission-off');
    const on = await readFile(new URL('09-weak-emission-on.png', output));
    const off = await readFile(new URL('10-weak-emission-off.png', output));
    if (on.equals(off)) errors.push('Emission toggle produced identical framebuffer');
  }
  const materialStatus = shots.find((shot) => shot.file === '02-after.png').status;
  if (materialStatus.optimized !== optimized)
    errors.push(
      'Runtime compression profile differs from capture arguments; use --optimized for the portable package',
    );
  if (
    !materialStatus.materials.every((m) => m.base && m.normal && m.roughness && m.metallic && m.ao)
  )
    errors.push('Missing PBR bindings');
  errors.push(...shots.flatMap((shot) => shot.status.errors));
  const loadedHashes = await Promise.all(loadedAssets);
  if (!loadedHashes.length || loadedHashes.some((hash) => hash !== assetSha256))
    errors.push('Runtime GLB differs from the reviewed local asset');
  await writeFile(
    new URL('validation.json', output),
    JSON.stringify(
      {
        renderer: 'Three.js WebGLRenderer / production loadChestAssets',
        assetSha256,
        loadedHashes,
        errors,
        shots,
        passed: errors.length === 0,
        status: errors.length ? 'failed' : 'passed',
      },
      null,
      2,
    ),
  );
  if (errors.length) throw new Error(errors.join('\n'));
} catch (error) {
  await writeFile(new URL('capture-failure.txt', output), String(error));
  await writeFile(
    new URL('validation.json', output),
    JSON.stringify(
      {
        passed: false,
        status: stage === 'server' || stage === 'browser' ? 'blocked' : 'failed',
        stage,
        assetSha256,
        error: String(error),
        errors,
        shots,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
