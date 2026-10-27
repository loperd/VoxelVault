/** Production game, fixture API, real assets. CPU/viewport emulation is NOT a mobile GPU test.
 * npm run perf:mobile -- [report-dir] [traveler deep-mine ender dragon relic]
 * PERF_PROFILES=iphone-x,iphone-11,android-mid PERF_CYCLES=2 npm run perf:mobile
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright';

const [output = 'artifacts/mobile-performance', ...requested] = process.argv.slice(2);
const cases = requested.length ? requested : ['traveler', 'deep-mine', 'ender', 'dragon', 'relic'];
const profiles = {
  'iphone-x': { width: 375, height: 812, dpr: 3, cpu: 4 },
  'iphone-11': { width: 414, height: 896, dpr: 2, cpu: 4 },
  'android-mid': { width: 393, height: 851, dpr: 2.75, cpu: 6 },
};
const selected = (process.env.PERF_PROFILES ?? Object.keys(profiles).join(',')).split(',');
const cycles = Number(process.env.PERF_CYCLES ?? 2);
assert.ok(Number.isSafeInteger(cycles) && cycles > 0 && cycles <= 20);
for (const name of selected) assert.ok(profiles[name], `Unknown profile ${name}`);
for (const name of cases)
  assert.ok(['traveler', 'deep-mine', 'ender', 'dragon', 'relic'].includes(name));
const root = resolve(import.meta.dirname, '..');
const catalog = JSON.parse(await readFile(join(root, 'public/items.json'), 'utf8'));
const winner = catalog.at(-1);
const report = {
  capturedAt: new Date().toISOString(),
  limitation:
    'Chromium viewport and CPU emulation on the host GPU. Not proof of iPhone Safari or Android GPU FPS.',
  runs: [],
};
await mkdir(output, { recursive: true });
let browser, server;
try {
  browser = await chromium.launch({ headless: true });
  report.browser = browser.version();
  server = await preview({
    root,
    logLevel: 'error',
    preview: { host: '127.0.0.1', port: 0, open: false },
  });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const profile of selected)
    for (const caseId of cases) {
      const { width, height, dpr, cpu } = profiles[profile];
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: dpr,
        isMobile: true,
        hasTouch: true,
        reducedMotion: 'no-preference',
      });
      const run = { profile, caseId, cpu, cycles: [], errors: [] };
      report.runs.push(run);
      try {
        const stock = Array.from({ length: cycles }, (_, i) => ({
          id: `perf-${i}`,
          caseId,
          status: 'available',
          seed: 7,
          condition: 1,
          traits: [],
          contents: catalog.map((item) => ({ item, weight: Number(item.chance) })),
        }));
        await context.route('**/api/**', async (route) => {
          const path = new URL(route.request().url()).pathname;
          let answer;
          if (path === '/api/v1/me')
            answer = { id: 'perf', handle: 'perf', displayName: 'Performance', roles: [] };
          else if (path === '/api/v1/inventory') answer = stock;
          else if (path === '/api/v1/inventory/items') answer = { items: [], balances: {} };
          else if (path.endsWith('/catalog')) answer = catalog;
          else {
            const match = path.match(/^\/api\/v1\/inventory\/(perf-\d+)\/(claim|open)$/);
            if (match) {
              const chest = stock.find((chest) => chest.id === match[1]);
              chest.sessionId = route.request().postDataJSON().sessionId;
              if (match[2] === 'claim') chest.status = 'opening';
              else
                Object.assign(chest, {
                  status: 'opened',
                  drop: { item: winner, state: 'intact' },
                  openedAt: new Date().toISOString(),
                });
              answer = { chest };
            }
          }
          await route.fulfill({
            status: answer ? 200 : 404,
            json: answer ?? { error: `Unmocked ${path}` },
          });
        });
        await context.addInitScript(() => {
          // Also exercise the iPhone X compatibility path in every run.
          Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
          let recording = false,
            previous,
            frame;
          let intervals = [],
            webgl = 0,
            layouts = 0,
            longTasks = [];
          for (const type of [
            globalThis.WebGLRenderingContext,
            globalThis.WebGL2RenderingContext,
          ]) {
            if (!type) continue;
            for (const name of [
              'drawArrays',
              'drawElements',
              'drawArraysInstanced',
              'drawElementsInstanced',
            ]) {
              const original = type.prototype[name];
              if (!original) continue;
              type.prototype[name] = function (...args) {
                if (recording) webgl++;
                return original.apply(this, args);
              };
            }
          }
          const bounds = Element.prototype.getBoundingClientRect;
          Element.prototype.getBoundingClientRect = function (...args) {
            if (recording && this.classList.contains('roulette--canvas')) layouts++;
            return bounds.apply(this, args);
          };
          try {
            new PerformanceObserver((list) => {
              if (recording) longTasks.push(...list.getEntries().map((e) => e.duration));
            }).observe({ type: 'longtask', buffered: false });
          } catch {}
          const tick = (now) => {
            if (previous !== undefined) intervals.push(now - previous);
            previous = now;
            frame = requestAnimationFrame(tick);
          };
          window.__mobileProbe = {
            start() {
              intervals = [];
              webgl = layouts = 0;
              longTasks = [];
              previous = undefined;
              recording = true;
              frame = requestAnimationFrame(tick);
            },
            stop() {
              cancelAnimationFrame(frame);
              recording = false;
              const sorted = [...intervals].sort((a, b) => a - b),
                canvas = document.querySelector('.roulette--canvas');
              return {
                frames: intervals.length,
                rafFps: (intervals.length * 1000) / intervals.reduce((a, b) => a + b, 0),
                frameIntervalP95Ms: sorted[Math.floor(sorted.length * 0.95)],
                framesOver25Ms: intervals.filter((ms) => ms > 25).length,
                webglDraws: webgl,
                rouletteLayoutReads: layouts,
                longTasksMs: longTasks,
                backingWidth: canvas?.width,
                backingHeight: canvas?.height,
              };
            },
          };
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => run.errors.push(String(error)));
        page.on('console', (message) => {
          if (message.type() === 'error') run.errors.push(message.text());
        });
        page.on('response', (response) => {
          if (response.status() >= 400)
            run.errors.push(`HTTP ${response.status()} ${response.url()}`);
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
        await page.goto(`${origin}/#/cases/${caseId}/instances/perf-0`, {
          waitUntil: 'networkidle',
        });
        for (let cycle = 0; cycle < cycles; cycle++) {
          const button = page.getByRole('button', { name: 'Открыть сундук', exact: true });
          await button.waitFor({ state: 'visible', timeout: 60_000 });
          await button.click();
          await page
            .locator('.roulette--canvas:not([hidden])')
            .waitFor({ state: 'visible', timeout: 60_000 });
          await page.waitForTimeout(350); // Flash and React effects finish before measuring steady spinning.
          await page.evaluate(() => window.__mobileProbe.start());
          await page.waitForTimeout(3000);
          const metrics = await page.evaluate(() => window.__mobileProbe.stop());
          run.cycles.push(metrics);
          assert.ok(metrics.frames > 0, 'animation must produce frames');
          assert.equal(metrics.webglDraws, 0, 'hidden world must not submit GPU draws');
          assert.equal(metrics.rouletteLayoutReads, 0, 'steady spin must not measure DOM layout');
          assert.ok(
            metrics.backingHeight > 0 && metrics.backingHeight <= 600,
            'canvas backing store is confined to the card band (≤ 300 CSS px at ratio ≤ 2)',
          );
          await page.screenshot({ path: join(output, `${profile}-${caseId}-${cycle}-spin.png`) });
          await page.locator('#prize-title').waitFor({ state: 'visible', timeout: 60_000 });
          assert.equal(await page.locator('#prize-title').innerText(), winner.title);
          assert.equal(
            await page.locator('.failsafe[open]').count(),
            0,
            'opening must not trigger the stuck-phase dialog',
          );
          await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
        }
        assert.deepEqual(run.errors, [], 'no runtime or network errors');
        console.log(
          `${profile}/${caseId}: ${run.cycles.map((c) => `${c.rafFps.toFixed(1)} rAF fps, p95 ${c.frameIntervalP95Ms.toFixed(1)}ms`).join('; ')}`,
        );
      } catch (error) {
        run.errors.push(String(error));
        process.exitCode = 1;
        console.error(`${profile}/${caseId}: FAILED\n${run.errors.join('\n')}`);
      } finally {
        await context.close();
        await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
      }
    }
} finally {
  await browser?.close();
  await new Promise((resolve) => (server ? server.httpServer.close(resolve) : resolve()));
}
