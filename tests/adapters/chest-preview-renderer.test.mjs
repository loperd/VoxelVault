import assert from 'node:assert/strict';
import test from 'node:test';
import { ChestPreviewRenderer } from '../../src/adapters/outbound/chest/chest-preview-renderer.ts';
import { createChestAppearance, changeChestAppearance } from '../../src/domain/chest-appearance.ts';
import { ENDER_CASE } from '../../src/config/cases.ts';
import { deferred, flush } from '../helpers.mjs';

const base = new URL('https://example.test/');
test('preview jobs are serial, share identical snapshots and invalidate on metadata change', async () => {
  let active = 0,
    maxActive = 0,
    calls = 0;
  const renderer = new ChestPreviewRenderer({}, base, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    calls++;
    await flush();
    active--;
    return { width: 640, height: 520 };
  });
  const appearance = createChestAppearance(),
    signal = new AbortController().signal;
  const [a, b] = await Promise.all([
    renderer.render(ENDER_CASE, appearance, signal),
    renderer.render(ENDER_CASE, appearance, signal),
  ]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  const changed = await renderer.render(
    ENDER_CASE,
    changeChestAppearance(appearance, { modifications: [{ id: 'body-cracks', intensity: 0.7 }] }),
    signal,
  );
  assert.notEqual(changed, a);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  renderer.dispose();
  assert.equal(a.width, 0);
  assert.equal(changed.width, 0);
});

test('aborted queued previews never render and disposed work cannot populate the cache', async () => {
  const pending = deferred();
  let calls = 0;
  const renderer = new ChestPreviewRenderer({}, base, async () => {
    calls++;
    return pending.promise;
  });
  const first = renderer.render(ENDER_CASE, createChestAppearance(), new AbortController().signal);
  const abort = new AbortController();
  const second = renderer.render(ENDER_CASE, createChestAppearance(2), abort.signal);
  const rejected = assert.rejects(second, { name: 'AbortError' });
  await flush();
  abort.abort();
  pending.resolve({ width: 640, height: 520 });
  await first;
  await rejected;
  assert.equal(calls, 1);
  renderer.dispose();
  await assert.rejects(
    renderer.render(ENDER_CASE, createChestAppearance(), new AbortController().signal),
  );
});

test('preview cache releases old backing buffers at its fixed budget', async () => {
  const images = [];
  const renderer = new ChestPreviewRenderer({}, base, async () => {
    const image = { width: 640, height: 520 };
    images.push(image);
    return image;
  });
  for (let seed = 0; seed < 20; seed++)
    await renderer.render(ENDER_CASE, createChestAppearance(seed), new AbortController().signal);
  assert.equal(images.filter((image) => image.width > 0).length, 12);
  renderer.dispose();
  assert.ok(images.every((image) => image.width === 0));
});

test('previews work without AbortSignal.any and lifetime cancellation releases an in-flight canvas', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
  const pending = deferred(),
    controller = new AbortController();
  const renderer = new ChestPreviewRenderer({}, base, async () => pending.promise);
  try {
    const result = renderer.render(ENDER_CASE, createChestAppearance(), controller.signal);
    const rejected = assert.rejects(result, { name: 'AbortError' });
    await flush();
    renderer.dispose();
    const canvas = { width: 640, height: 520 };
    pending.resolve(canvas);
    await rejected;
    assert.equal(canvas.width * canvas.height, 0);
    const other = new ChestPreviewRenderer({}, base, async () => ({ width: 640, height: 520 }));
    try {
      assert.equal(
        (await other.render(ENDER_CASE, createChestAppearance(), controller.signal)).width,
        640,
      );
    } finally {
      other.dispose();
    }
  } finally {
    renderer.dispose();
    if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor);
    else delete AbortSignal.any;
  }
});
