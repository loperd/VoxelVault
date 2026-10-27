/** Owner-run real GPU validation, separate from offline evidence. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = new URL('../../artifacts/relic-material-lookdev/runtime/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 4187, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_EXECUTABLE ??
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined),
    headless: true,
    timeout: 15_000,
  });
  const page = await browser.newPage({
    viewport: { width: 1480, height: 1650 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('http://127.0.0.1:4187/material-lookdev.html');
  await page.waitForFunction(() => window.materialStudy?.status().ready);
  const status = await page.evaluate(() => window.materialStudy.status());
  if (status.errors.length || !status.textureCount)
    throw new Error('GPU setup failed: ' + JSON.stringify(status));
  async function pixels(family) {
    return page.evaluate((f) => window.materialStudy.pixels(f), family);
  }
  const before = {};
  for (const family of ['obsidian', 'metal', 'crystal']) before[family] = await pixels(family);
  await page.locator('canvas').screenshot({ path: new URL('matrix-neutral.png', output).pathname });
  const checks = [];
  for (const [family, channel] of [
    ['obsidian', 'normal'],
    ['obsidian', 'roughness'],
    ['metal', 'normal'],
    ['metal', 'metallic'],
    ['crystal', 'emissive'],
  ]) {
    await page.uncheck(`#${channel}`);
    const after = await pixels(family),
      original = before[family];
    let total = 0;
    for (let i = 0; i < after.length; i++) total += Math.abs(after[i] - original[i]);
    const difference = total / after.length;
    checks.push({
      family,
      channel,
      meanAbsoluteByteDifference: difference,
      pass: difference > 0.05,
    });
    await page
      .locator('canvas')
      .screenshot({ path: new URL(`${family}-${channel}-off.png`, output).pathname });
    await page.check(`#${channel}`);
  }
  await page.selectOption('#rig', 'grazing');
  await page.locator('canvas').screenshot({ path: new URL('matrix-grazing.png', output).pathname });
  await page.selectOption('#rig', 'app');
  await page
    .locator('canvas')
    .screenshot({ path: new URL('matrix-application-lights.png', output).pathname });
  const result = {
    ...status,
    checks,
    errors,
    passed: checks.every((c) => c.pass) && !errors.length,
    scope:
      'Real GPU pixel ablations. Metallic toggle tests metal BRDF contribution, not isolated ORM channel swizzle; core R/G/B bindings are separately checked against GLTFLoader/shader source.',
  };
  await writeFile(new URL('validation.json', output), JSON.stringify(result, null, 2));
  if (!result.passed) throw new Error('GPU channel ablation failed');
} catch (error) {
  await writeFile(new URL('failure.txt', output), String(error));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
