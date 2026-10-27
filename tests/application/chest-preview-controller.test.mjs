import assert from 'node:assert/strict';
import test from 'node:test';
import { ChestPreviewController } from '../../src/application/chest-preview-controller.ts';
import { deferred, flush } from '../helpers.mjs';

function harness(overrides = {}) {
  const calls = {},
    listeners = new Set();
  const method =
    (name) =>
    (...args) => {
      (calls[name] ??= []).push(args);
      return (overrides[name] ?? (async () => {}))(...args);
    };
  const scene = {
    prepare: method('prepare'),
    drop: method('drop'),
    reset: method('reset'),
    subscribeErrors(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: method('dispose'),
  };
  return {
    controller: new ChestPreviewController(scene),
    calls,
    listeners,
    error(error) {
      for (const listener of listeners) listener(error);
    },
  };
}

test('preview waits for assets and starts exactly one initial drop', async () => {
  const pending = deferred(),
    h = harness({ prepare: () => pending.promise });
  const loading = h.controller.initialize();
  await h.controller.initialize();
  await flush();
  assert.equal(h.controller.getState().phase, 'loading');
  assert.equal(h.calls.prepare.length, 1);
  assert.equal(h.calls.drop, undefined);
  pending.resolve();
  await loading;
  assert.equal(h.controller.getState().phase, 'ready');
  assert.equal(h.calls.drop.length, 1);
  h.controller.dispose();
});

test('replay cancels the previous drop, resets once, and blocks duplicate commands', async () => {
  const pending = deferred(),
    h = harness({ reset: () => pending.promise });
  await h.controller.initialize();
  const old = h.calls.drop[0][0];
  const replay = h.controller.replay();
  await h.controller.replay();
  await flush();
  assert.equal(old.aborted, true);
  assert.equal(h.controller.getState().phase, 'resetting');
  assert.equal(h.calls.reset.length, 1);
  pending.resolve();
  await replay;
  assert.equal(h.calls.drop.length, 2);
  assert.equal(h.controller.getState().phase, 'ready');
  h.controller.dispose();
});

test('preparation and later frame failures both offer a full retry', async () => {
  let attempts = 0;
  const h = harness({
    prepare: async () => {
      if (++attempts === 1) throw new Error('WebGL unavailable');
    },
  });
  await h.controller.initialize();
  assert.equal(h.controller.getState().phase, 'failed');
  await h.controller.retry();
  assert.equal(h.controller.getState().phase, 'ready');
  const activeSignal = h.calls.drop.at(-1)[0];
  h.error(new Error('Context lost'));
  assert.equal(activeSignal.aborted, true);
  assert.equal(h.controller.getState().phase, 'failed');
  await h.controller.retry();
  assert.equal(h.controller.getState().phase, 'ready');
  assert.equal(attempts, 3);
  h.controller.dispose();
});

test('dispose cancels an ignored preparation and removes runtime error listeners', async () => {
  const pending = deferred(),
    h = harness({ prepare: () => pending.promise });
  const loading = h.controller.initialize();
  await flush();
  h.controller.dispose();
  await loading;
  assert.equal(h.listeners.size, 0);
  assert.equal(h.controller.getState().phase, 'disposed');
  assert.equal(h.calls.dispose.length, 1);
  pending.resolve();
  await flush();
  h.error(new Error('Late'));
  assert.equal(h.calls.drop, undefined);
  assert.equal(h.controller.getState().phase, 'disposed');
  h.controller.dispose();
  assert.equal(h.calls.dispose.length, 1);
});

test('100 preview replays reuse prepared assets and release the scene once', async () => {
  const h = harness();
  await h.controller.initialize();
  for (let i = 0; i < 100; i++) await h.controller.replay();
  assert.equal(h.calls.prepare.length, 1);
  assert.equal(h.calls.reset.length, 100);
  assert.equal(h.calls.drop.length, 101);
  h.controller.dispose();
  assert.equal(h.calls.dispose.length, 1);
});
