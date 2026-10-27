import { CanvasRoulette } from '../adapters/outbound/browser/canvas-roulette.ts';
import { browserFrameEnvironment } from '../adapters/outbound/browser/frame-scheduler.ts';
import { FixtureCatalogGateway } from '../adapters/outbound/data/fixture-catalog-gateway.ts';
import { FixtureOutcomeGateway } from '../adapters/outbound/data/fixture-outcome-gateway.ts';
import { buildStrip, ensureTarget } from '../domain/strip.ts';
import { createSpinPlan } from '../domain/spin-plan.ts';
import type { Item } from '../domain/item.ts';

// Standalone development page: exercises the real renderer without Three.js/Rapier or React.
const baseUrl = new URL('.', document.baseURI);
const catalog = new FixtureCatalogGateway(baseUrl),
  prize = new FixtureOutcomeGateway(baseUrl);
const environment = browserFrameEnvironment(window, document);
const costs: number[] = [];
const intervals: number[] = [];
let lastFrame: number | undefined;
document.addEventListener('visibilitychange', () => {
  lastFrame = undefined;
});
const roulette = new CanvasRoulette(document, {
  environment: {
    ...environment,
    requestFrame(callback) {
      return environment.requestFrame((time) => {
        if (lastFrame !== undefined) intervals.push(time - lastFrame);
        lastFrame = time;
        const start = performance.now();
        callback(time);
        costs.push(performance.now() - start);
      });
    },
  },
});
const button = document.getElementById('spin') as HTMLButtonElement;
const reset = document.getElementById('reset') as HTMLButtonElement;
const status = document.getElementById('status')!;
document.getElementById('viewport')!.append(roulette.element);
const random = { next: () => Math.random() };
let items: readonly Item[] = [],
  operation: AbortController | undefined;

async function spin(): Promise<void> {
  operation?.abort();
  operation = new AbortController();
  const current = operation;
  costs.length = 0;
  intervals.length = 0;
  lastFrame = undefined;
  button.disabled = true;
  status.textContent = 'Крутим…';
  try {
    const decided = await prize.decide(crypto.randomUUID(), current.signal);
    if (!('prize' in decided)) return;
    const winner = decided.prize;
    const selection = ensureTarget(buildStrip(items, 40, random), winner, random);
    await roulette.spin(selection, createSpinPlan(selection), current.signal);
    if (operation === current) status.textContent = `Выпало: ${winner.title}`;
  } catch (error) {
    if (operation === current && !current.signal.aborted)
      status.textContent = error instanceof Error ? error.message : 'Ошибка';
  } finally {
    if (operation === current) button.disabled = false;
  }
}
button.onclick = () => {
  void spin();
};
reset.onclick = () => {
  operation?.abort();
  operation = undefined;
  roulette.reset();
  button.disabled = false;
  status.textContent = 'Готово';
};
const controller = new AbortController();
void Promise.all([catalog.load(controller.signal), roulette.prepare(controller.signal)]).then(
  ([loaded]) => {
    items = loaded;
    button.disabled = false;
    status.textContent = 'Готово';
  },
  (error) => {
    status.textContent = error instanceof Error ? error.message : 'Ошибка загрузки';
  },
);

Object.assign(window, {
  canvasPreview: {
    spin,
    stats() {
      const sorted = [...costs].sort((a, b) => a - b);
      const gaps = [...intervals].sort((a, b) => a - b);
      return {
        frames: sorted.length,
        drawSubmissionP95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? null,
        frameIntervalP95Ms: gaps[Math.floor(gaps.length * 0.95)] ?? null,
        framesOver25Ms: gaps.filter((ms) => ms > 25).length,
        averageRafFps: intervals.length
          ? (intervals.length * 1000) / intervals.reduce((sum, ms) => sum + ms, 0)
          : null,
        drawSubmissionMaxMs: sorted.at(-1) ?? null,
        canvasCount: document.querySelectorAll('canvas').length,
        backingWidth: roulette.element.width,
        backingHeight: roulette.element.height,
      };
    },
  },
});
window.addEventListener(
  'pagehide',
  () => {
    operation?.abort();
    controller.abort();
    roulette.dispose();
    catalog.dispose();
  },
  { once: true },
);
