import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CanvasRoulette,
  LOCK_SECONDS,
} from '../../src/adapters/outbound/browser/canvas-roulette.ts';
import { GameTransitions } from '../../src/adapters/outbound/browser/game-transitions.ts';
import { createSpinPlan } from '../../src/domain/spin-plan.ts';
import { buildStrip, ensureTarget } from '../../src/domain/strip.ts';
import { constantRandom, deferred, item, legacyCatalog } from '../helpers.mjs';
import { frameEnvironment } from '../frame-environment.mjs';
import { canvasFactory } from '../canvas-harness.mjs';

const build = pathToFileURL(resolve(process.env.MCROULETTE_UI_BUILD ?? '.test-build/src') + '/');
const require = createRequire(new URL('package.json', build));
const { Window } = await import(pathToFileURL(require.resolve('happy-dom')));

function harness(width = 720) {
  const window = new Window(),
    env = frameEnvironment();
  let ticks = 0,
    now = 0;
  const canvas = canvasFactory(window.document);
  const roulette = new CanvasRoulette(window.document, {
    ...canvas,
    environment: env,
    sound: {
      tick() {
        ticks++;
      },
      stop() {},
    },
  });
  window.document.body.append(roulette.element);
  roulette.element.getBoundingClientRect = () => ({ width, height: 360 });
  return {
    window,
    env,
    roulette,
    ...canvas,
    get ticks() {
      return ticks;
    },
    frames(count, hz = 60) {
      for (let index = 0; index < count; index++) {
        env.tick(now);
        now += 1000 / hz;
      }
    },
    dispose() {
      roulette.dispose();
      window.close();
    },
  };
}

function underCursor(canvas, width) {
  const draw = canvas.context.draws
    .filter((draw) => draw.source.imageUrl)
    .find((draw) => draw.x <= width / 2 && draw.x + draw.width >= width / 2);
  assert.ok(draw, 'cursor stops inside a card, excluding gap');
  return draw.source.imageUrl;
}

async function loaded() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

test('the canvas strip stops on the authoritative prize at every refresh rate and viewport width', async () => {
  for (const width of [320, 375, 414, 720, 1800])
    for (const hz of [15, 30, 60, 120])
      for (const jitter of [0, 0.99]) {
        const h = harness(width),
          signal = new AbortController().signal;
        const selection = ensureTarget(
          buildStrip(legacyCatalog(), 40, constantRandom()),
          legacyCatalog()[13],
          constantRandom(),
        );
        const plan = createSpinPlan(selection);
        await h.roulette.prepare(signal);
        const done = h.roulette.spin(selection, plan, signal);
        await loaded();
        h.frames(Math.ceil((plan.durationSeconds + LOCK_SECONDS) * hz) + 3, hz);
        await done;
        assert.equal(underCursor(h.roulette.element, width), selection.prize.image);
        const draws = h.roulette.element.context.draws.filter((draw) => draw.source.imageUrl);
        assert.ok(
          draws.every((draw) => !draw.clipped),
          'one sharp pass, no lens',
        );
        const prize = draws.find((draw) => draw.x <= width / 2 && draw.x + draw.width >= width / 2);
        assert.ok(
          draws.every((draw) => draw.width <= prize.width),
          'the card under the pointer is the largest',
        );
        assert.ok(
          draws.length <= Math.ceil(width / 200) + 1,
          'only cards intersecting the viewport are submitted',
        );
        assert.ok(draws.every((draw) => draw.x <= width && draw.x + draw.width >= 0));
        assert.equal(h.window.document.querySelectorAll('canvas').length, 1);
        assert.ok(h.ticks > 0);
        assert.equal(h.env.frames.size, 0);
        h.dispose();
        assert.equal(h.env.listeners.size, 0);
      }
});

test('a one-item canvas strip remains bounded and reuses image caches across 100 spins', async () => {
  const h = harness(1800),
    signal = new AbortController().signal;
  const prize = item('one', 0, { title: '<script>alert(1)</script>' });
  const selection = ensureTarget([], prize, constantRandom());
  const plan = createSpinPlan(selection, {
    deceleration: 1,
    nominalTimeSeconds: 0.1,
    timeScale: 0.05,
  });
  for (let index = 0; index < 100; index++) {
    const done = h.roulette.spin(selection, plan, signal);
    await loaded();
    h.frames(Math.ceil((plan.durationSeconds + LOCK_SECONDS) * 60) + 3);
    await done;
    assert.equal(h.canvases.length, 4, 'strip, card, glow and flash surfaces are reused');
    assert.equal(h.requests.length, 1);
    assert.equal(h.roulette.element.querySelector('script'), null);
    assert.equal(underCursor(h.roulette.element, 1800), prize.image);
    h.roulette.reset();
    assert.equal(h.env.frames.size, 0);
    assert.equal(h.roulette.element.children.length, 0);
  }
  h.dispose();
  assert.equal(h.env.listeners.size, 0);
  assert.ok(h.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
});

test('aborting a canvas spin hides the strip and prevents a delayed prize reveal', async () => {
  const h = harness(),
    abort = new AbortController();
  const selection = ensureTarget([], item('one'), constantRandom());
  const plan = createSpinPlan(selection);
  const done = h.roulette.spin(selection, plan, abort.signal);
  const rejected = assert.rejects(done, /cancelled/);
  await loaded();
  h.frames(10);
  abort.abort(new Error('cancelled'));
  await rejected;
  assert.equal(h.roulette.element.hidden, true);
  assert.equal(h.roulette.element.querySelectorAll('.roulette__cell').length, 0);
  assert.equal(h.env.frames.size, 0);
  h.dispose();
});

test('abort during image loading settles immediately and late images cannot repaint a new spin', async () => {
  const window = new Window(),
    env = frameEnvironment(),
    factory = canvasFactory(window.document),
    pending = deferred();
  const roulette = new CanvasRoulette(window.document, {
    ...factory,
    environment: env,
    loadImage: (url) => (url.includes('old') ? pending.promise : factory.loadImage(url)),
  });
  roulette.element.getBoundingClientRect = () => ({ width: 720, height: 360 });
  const abort = new AbortController(),
    old = ensureTarget([], item('old'), constantRandom());
  const task = roulette.spin(old, createSpinPlan(old), abort.signal);
  const rejected = assert.rejects(task, /cancelled/);
  await loaded();
  abort.abort(new Error('cancelled'));
  await rejected;
  assert.equal(roulette.element.hidden, true);
  assert.equal(env.frames.size, 0);
  window.matchMedia = () => ({ matches: true });
  const next = ensureTarget([], item('new'), constantRandom());
  await roulette.spin(next, createSpinPlan(next), new AbortController().signal);
  pending.resolve({ width: 100, height: 100, src: '/items/old.png' });
  await loaded();
  assert.equal(underCursor(roulette.element, 720), next.prize.image);
  assert.equal(factory.canvases.length, 3);
  roulette.dispose();
  window.close();
});

test('image failure can retry and changing authoritative image releases stale card surfaces', async () => {
  const window = new Window(),
    factory = canvasFactory(window.document);
  let fail = true;
  window.matchMedia = () => ({ matches: true });
  const roulette = new CanvasRoulette(window.document, {
    ...factory,
    environment: frameEnvironment(),
    loadImage: (url) => (fail ? Promise.reject(new Error('image failed')) : factory.loadImage(url)),
  });
  roulette.element.getBoundingClientRect = () => ({ width: 320, height: 300 });
  const signal = new AbortController().signal;
  const first = ensureTarget([], item('one'), constantRandom());
  await assert.rejects(roulette.spin(first, createSpinPlan(first), signal), /image failed/);
  assert.equal(roulette.element.hidden, true);
  fail = false;
  await roulette.spin(first, createSpinPlan(first), signal);
  const oldCards = factory.canvases.slice(1).filter((canvas) => canvas.imageUrl);
  const changed = ensureTarget([], item('one', 0, { image: '/new.png' }), constantRandom());
  await roulette.spin(changed, createSpinPlan(changed), signal);
  assert.equal(underCursor(roulette.element, 320), '/new.png');
  assert.ok(oldCards.every((canvas) => canvas.width === 0 && canvas.height === 0));
  roulette.dispose();
  window.close();
});

test('missing Canvas 2D fails explicitly instead of offering a nonfunctional spin', async () => {
  const window = new Window(),
    canvas = window.document.createElement('canvas');
  canvas.getContext = () => null;
  const roulette = new CanvasRoulette(window.document, {
    environment: frameEnvironment(),
    createCanvas: () => canvas,
  });
  await assert.rejects(
    roulette.prepare(new AbortController().signal),
    /Canvas 2D is not available/,
  );
  roulette.dispose();
  window.close();
});

test('a replaced spin rejects without clearing the newer animation or its authoritative target', async () => {
  const h = harness(),
    signal = new AbortController().signal;
  const first = ensureTarget([], item('old'), constantRandom());
  const second = ensureTarget([], item('new'), constantRandom());
  const old = h.roulette.spin(first, createSpinPlan(first), signal);
  const rejected = assert.rejects(old, /replaced/);
  await loaded();
  h.frames(5);
  const plan = createSpinPlan(second);
  const current = h.roulette.spin(second, plan, signal);
  await rejected;
  await loaded();
  assert.equal(h.roulette.element.hidden, false);
  assert.equal(h.env.frames.size, 1);
  h.frames(Math.ceil((plan.durationSeconds + LOCK_SECONDS) * 60) + 3);
  await current;
  assert.equal(underCursor(h.roulette.element, 720), second.prize.image);
  assert.equal(h.env.frames.size, 0);
  h.dispose();
});

test('reduced motion skips rotation and ticks but retains the exact authoritative landing', async () => {
  const h = harness(),
    signal = new AbortController().signal;
  h.window.matchMedia = () => ({ matches: true });
  const selection = ensureTarget(
    buildStrip(legacyCatalog(), 40, constantRandom()),
    legacyCatalog()[13],
    constantRandom(),
  );
  const plan = createSpinPlan(selection);
  await h.roulette.spin(selection, plan, signal);
  assert.equal(h.env.frames.size, 0);
  assert.equal(h.ticks, 0);
  assert.equal(underCursor(h.roulette.element, 720), selection.prize.image);
  h.dispose();
});

test('resizing during a spin changes the visible window while preserving its target', async () => {
  const h = harness(),
    signal = new AbortController().signal;
  const selection = ensureTarget(
    buildStrip(legacyCatalog(), 40, constantRandom()),
    legacyCatalog()[13],
    constantRandom(),
  );
  const plan = createSpinPlan(selection);
  const done = h.roulette.spin(selection, plan, signal);
  await loaded();
  h.frames(10);
  h.roulette.element.getBoundingClientRect = () => ({ width: 1800, height: 300 });
  h.window.dispatchEvent(new h.window.Event('resize'));
  h.frames(Math.ceil((plan.durationSeconds + LOCK_SECONDS) * 60) + 3);
  await done;
  assert.equal(underCursor(h.roulette.element, 1800), selection.prize.image);
  assert.equal(h.roulette.element.height, Math.ceil(300 * Math.min(h.window.devicePixelRatio, 2)));
  h.dispose();
});

test('animation frames do not read layout and a CSS scale does not change the winning card', async () => {
  const h = harness(375),
    signal = new AbortController().signal;
  Object.defineProperties(h.roulette.element, {
    clientWidth: { value: 375 },
    clientHeight: { value: 164 },
  });
  h.roulette.element.getBoundingClientRect = () => {
    throw new Error('unexpected layout read');
  };
  const selection = ensureTarget(
    buildStrip(legacyCatalog(), 40, constantRandom()),
    legacyCatalog()[13],
    constantRandom(),
  );
  const plan = createSpinPlan(selection);
  try {
    const done = h.roulette.spin(selection, plan, signal);
    await loaded();
    h.frames(Math.ceil((plan.durationSeconds + LOCK_SECONDS) * 60) + 3);
    await done;
    assert.equal(underCursor(h.roulette.element, 375), selection.prize.image);
    assert.equal(h.roulette.element.height, 164 * Math.min(h.window.devicePixelRatio, 2));
    assert.ok(
      h.roulette.element.context.draws.every((draw) => draw.y >= 0 && draw.y + draw.height <= 164),
    );
  } finally {
    h.dispose();
  }
});

test('layout is measured once on show, then again only when resized', async () => {
  const h = harness(375),
    signal = new AbortController().signal;
  let reads = 0;
  h.roulette.element.getBoundingClientRect = () => {
    reads++;
    return { width: 375, height: 164 };
  };
  const selection = ensureTarget([], item('one'), constantRandom());
  const plan = createSpinPlan(selection);
  try {
    const done = h.roulette.spin(selection, plan, signal);
    await loaded();
    h.frames(60);
    assert.equal(reads, 1);
    h.window.dispatchEvent(new h.window.Event('resize'));
    h.frames(60);
    assert.equal(reads, 2);
    h.frames(Math.ceil((plan.durationSeconds + LOCK_SECONDS) * 60) + 3);
    await done;
    assert.equal(underCursor(h.roulette.element, 375), selection.prize.image);
  } finally {
    h.dispose();
  }
});

test('real transitions preserve hold, fade, hidden state and reset delays without wall-clock timers', async () => {
  const h = harness(),
    env = frameEnvironment(),
    transitions = new GameTransitions(env, h.roulette.element);
  const signal = new AbortController().signal;
  let now = 0,
    finished = false;
  const frames = (count) => {
    for (let i = 0; i < count; i++) {
      env.tick(now);
      now += 1000 / 60;
    }
  };
  h.roulette.element.hidden = false;
  const held = transitions.holdStoppedStrip(signal).then(() => {
    finished = true;
  });
  frames(30);
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(h.roulette.element.hidden, false);
  frames(50);
  await held;
  const revealed = transitions.revealPrize(signal);
  frames(20);
  assert.ok(Number(h.roulette.element.style.opacity) < 1);
  assert.equal(h.roulette.element.hidden, false);
  frames(20);
  await revealed;
  assert.equal(h.roulette.element.hidden, true);
  const reset = transitions.resetToIntro(signal);
  frames(40);
  await reset;
  transitions.dispose();
  assert.equal(env.frames.size, 0);
  assert.equal(env.listeners.size, 0);
  h.dispose();
});

test('flash reaches its opaque switching point before fading onto the next scene', async () => {
  const h = harness(),
    env = frameEnvironment(),
    transitions = new GameTransitions(env, h.roulette.element);
  const signal = new AbortController().signal;
  const flash = transitions.flashToRoulette(signal);
  env.tick(0);
  env.tick(60);
  assert.ok(
    Number(transitions.element.style.opacity) > 0 && Number(transitions.element.style.opacity) < 1,
  );
  env.tick(120);
  await flash;
  assert.equal(transitions.element.style.opacity, '1');
  const fade = transitions.finishFlash(signal);
  for (let time = 200; time <= 600; time += 50) env.tick(time);
  await fade;
  assert.equal(transitions.element.style.opacity, '0');
  transitions.dispose();
  assert.equal(env.frames.size, 0);
  assert.equal(env.listeners.size, 0);
  h.dispose();
});

test('reduced motion removes entrance travel and white flash without changing phase completion', async () => {
  const h = harness(),
    env = frameEnvironment();
  h.window.matchMedia = () => ({ matches: true });
  const transitions = new GameTransitions(env, h.roulette.element),
    signal = new AbortController().signal;
  await transitions.clearContent(signal);
  await transitions.flashToRoulette(signal);
  await transitions.finishFlash(signal);
  assert.equal(env.frames.size, 0);
  assert.equal(transitions.element.style.opacity, '0');
  transitions.dispose();
  h.dispose();
});
