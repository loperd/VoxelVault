import assert from 'node:assert/strict';
import test from 'node:test';
import { RouletteController } from '../../src/application/roulette-controller.ts';
import { constantRandom, deferred, flush, item, legacyCatalog } from '../helpers.mjs';

function harness(overrides = {}) {
  const calls = {};
  const signals = [];
  const method =
    (name, fallback, signalIndex = 0) =>
    (...args) => {
      (calls[name] ??= []).push(args);
      const signal = args[signalIndex];
      if (signal instanceof AbortSignal) signals.push(signal);
      return (overrides[name] ?? fallback)(...args);
    };
  let sequence = 0;
  const dependencies = {
    journal: overrides.journal,
    ownership: overrides.ownership,
    catalog: { load: method('load', async () => legacyCatalog()) },
    // A stub answering an item means the server dropped that prize.
    outcome: {
      decide: (...args) =>
        Promise.resolve(method('select', async () => legacyCatalog()[13], 1)(...args)).then(
          (value) =>
            value && typeof value === 'object' && ('prize' in value || 'destroyed' in value)
              ? value
              : { prize: value },
        ),
    },
    chest: {
      subscribeErrors: overrides.subscribeErrors,
      prepare: method('prepareChest', async () => {}),
      stageForDrop: overrides.stageForDrop
        ? method('stageForDrop', overrides.stageForDrop)
        : undefined,
      preview: overrides.preview ? method('preview', overrides.preview) : undefined,
      drop: method('drop', async () => {}),
      open: method('open', async () => {}),
      hide: method('hide', () => {}),
      reset: method('resetChest', async () => {}),
      dispose: method('disposeChest', () => {}),
    },
    roulette: {
      prepare: method('prepareRoulette', async () => {}),
      prepareSpin: method('prepareSpin', async () => {}, 1),
      spin: method('spin', async () => {}, 2),
      reset: method('resetRoulette', () => {}),
      dispose: method('disposeRoulette', () => {}),
    },
    transitions: {
      clearContent: method('clearContent', async () => {}),
      flashToRoulette: method('flash', async () => {}),
      finishFlash: method('finishFlash', async () => {}),
      holdStoppedStrip: method('hold', async () => {}),
      revealPrize: method('reveal', async () => {}),
      resetToIntro: method('resetTransition', async () => {}),
      dispose: method('disposeTransitions', () => {}),
    },
    random: overrides.random ?? constantRandom(),
    createSessionId: () => `session-${++sequence}`,
  };
  return { controller: new RouletteController(dependencies), calls, signals };
}

test('a runtime chest failure aborts active presentation and Retry prepares a fresh scene', async () => {
  let report;
  const listeners = new Set();
  const h = harness({
    subscribeErrors: (listener) => {
      report = listener;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  await h.controller.initialize();
  report(new Error('GPU context lost'));
  assert.equal(h.controller.getState().phase, 'failed');
  assert.equal(h.controller.getState().failure.recovery, 'initialize');
  assert.ok(h.signals.every((signal) => signal.aborted));
  await h.controller.retry();
  assert.equal(h.controller.getState().phase, 'ready');
  assert.equal(h.calls.prepareChest.length, 2);
  h.controller.dispose();
  assert.equal(listeners.size, 0);
  report(new Error('stale failure'));
  assert.equal(h.controller.getState().phase, 'disposed');
});

test('initialization prepares assets but falling starts only after the Open command', async () => {
  const catalog = deferred();
  const assets = deferred();
  const h = harness({ load: () => catalog.promise, prepareChest: () => assets.promise });
  const loading = h.controller.initialize();
  await h.controller.initialize();
  assert.equal(h.controller.getState().phase, 'loading');
  await flush();
  catalog.resolve(legacyCatalog());
  await flush();
  assert.equal(h.calls.drop, undefined);
  assets.resolve();
  await loading;
  assert.equal(h.controller.getState().phase, 'ready');
  assert.equal(h.controller.getState().catalog.length, 14);
  assert.equal(h.controller.getState().slots.length, 39);
  assert.equal(h.calls.load.length, 1);
  h.controller.dispose();
});

test('the initial screen shows a floating preview and restores it after Close without starting physics', async () => {
  const h = harness({ preview: async () => {} });
  await h.controller.initialize();
  assert.equal(h.controller.getState().phase, 'ready');
  assert.equal(h.calls.preview.length, 1);
  assert.equal(h.calls.drop, undefined);
  assert.equal(h.calls.hide, undefined);
  await h.controller.openChest();
  await h.controller.closePrize();
  assert.equal(h.calls.drop.length, 1);
  assert.equal(h.calls.preview.length, 2);
  assert.equal(h.controller.getState().phase, 'ready');
  h.controller.dispose();
});

test("the fall waits for the server's outcome, the roulette for the opening clips", async () => {
  const outcome = deferred();
  const clips = deferred();
  const h = harness({ select: () => outcome.promise, open: () => clips.promise });
  await h.controller.initialize();
  const phases = [];
  h.controller.subscribe(() => phases.push(h.controller.getState().phase));
  const opening = h.controller.openChest();
  await h.controller.openChest();
  await flush();
  assert.equal(h.calls.select.length, 1);
  assert.equal(h.calls.clearContent.length, 1, 'the screen clears while the server decides');
  assert.equal(h.calls.drop, undefined, 'nothing falls before the server has decided');
  outcome.resolve(legacyCatalog()[13]);
  await flush();
  await flush();
  assert.equal(h.controller.getState().phase, 'opening');
  assert.equal(h.calls.spin, undefined);
  clips.resolve();
  await opening;
  assert.deepEqual(phases, [
    'clearing',
    'dropping',
    'opening',
    'flashing',
    'spinning',
    'settling',
    'revealing',
    'prize-visible',
  ]);
  const state = h.controller.getState();
  assert.equal(state.selection.prize.id, '14');
  assert.equal(state.selection.slots[state.selection.targetIndex].item.id, '14');
  assert.equal(state.slots.length, 40);
  h.controller.dispose();
});

test('stopped strip and prize reveal are independently awaited', async () => {
  const spin = deferred(),
    hold = deferred(),
    reveal = deferred();
  const h = harness({
    spin: () => spin.promise,
    hold: () => hold.promise,
    reveal: () => reveal.promise,
  });
  await h.controller.initialize();
  const opening = h.controller.openChest();
  await flush();
  assert.equal(h.controller.getState().phase, 'spinning');
  spin.resolve();
  await flush();
  assert.equal(h.controller.getState().phase, 'settling');
  hold.resolve();
  await flush();
  assert.equal(h.controller.getState().phase, 'revealing');
  reveal.resolve();
  await opening;
  assert.equal(h.controller.getState().phase, 'prize-visible');
  h.controller.dispose();
});

test('scene barriers enforce clear → landing → clips → warm assets → flash → spin', async () => {
  const clear = deferred(),
    landing = deferred(),
    clips = deferred(),
    assets = deferred(),
    flash = deferred(),
    finish = deferred();
  const h = harness({
    clearContent: () => clear.promise,
    drop: () => landing.promise,
    open: () => clips.promise,
    prepareSpin: () => assets.promise,
    flash: () => flash.promise,
    finishFlash: () => finish.promise,
  });
  await h.controller.initialize();
  assert.equal(h.calls.drop, undefined);
  const opening = h.controller.openChest();
  await flush();
  assert.equal(h.controller.getState().phase, 'clearing');
  assert.equal(h.calls.drop, undefined);
  clear.resolve();
  await flush();
  assert.equal(h.controller.getState().phase, 'dropping');
  assert.equal(h.calls.open, undefined);
  landing.resolve();
  await flush();
  assert.equal(h.controller.getState().phase, 'opening');
  assert.equal(h.calls.flash, undefined);
  clips.resolve();
  await flush();
  assert.equal(h.calls.prepareSpin.length, 1);
  assert.equal(h.calls.flash, undefined);
  assets.resolve();
  await flush();
  assert.equal(h.controller.getState().phase, 'flashing');
  assert.equal(h.calls.spin, undefined);
  flash.resolve();
  await flush();
  assert.equal(h.controller.getState().phase, 'spinning');
  assert.equal(h.calls.spin.length, 1);
  assert.equal(
    h.calls.hold,
    undefined,
    'finishFlash belongs to the transition, not the stopped-prize hold',
  );
  finish.resolve();
  await opening;
  assert.equal(h.controller.getState().phase, 'prize-visible');
  h.controller.dispose();
});

test('disposal during falling cannot start clips or flash after a late landing result', async () => {
  const landing = deferred(),
    h = harness({ drop: () => landing.promise });
  await h.controller.initialize();
  const task = h.controller.openChest();
  await flush();
  assert.equal(h.controller.getState().phase, 'dropping');
  h.controller.dispose();
  await task;
  landing.resolve();
  await flush();
  assert.equal(h.calls.open, undefined);
  assert.equal(h.calls.flash, undefined);
  assert.equal(h.controller.getState().phase, 'disposed');
});

test('a failed entrance cancels result selection and can retry the same session without starting a fall early', async () => {
  let attempts = 0;
  const h = harness({
    clearContent: async () => {
      if (++attempts === 1) throw new Error('Entrance failed');
    },
  });
  await h.controller.initialize();
  await h.controller.openChest();
  assert.equal(h.controller.getState().phase, 'failed');
  assert.equal(h.calls.drop, undefined);
  await h.controller.retry();
  assert.equal(h.controller.getState().phase, 'prize-visible');
  assert.equal(h.calls.drop.length, 1);
  assert.ok(h.calls.select.every((args) => args[0] === 'session-1'));
  h.controller.dispose();
});

test('close resets once, retains the strip, and the next open requests a new result', async () => {
  const transition = deferred();
  const h = harness({ resetTransition: () => transition.promise });
  await h.controller.initialize();
  await h.controller.openChest();
  const slots = h.controller.getState().slots;
  const closing = h.controller.closePrize();
  await h.controller.closePrize();
  await h.controller.openChest();
  await flush();
  assert.equal(h.controller.getState().phase, 'resetting');
  assert.equal(h.calls.resetChest.length, 1);
  assert.equal(h.calls.select.length, 1);
  transition.resolve();
  await closing;
  assert.equal(h.controller.getState().phase, 'ready');
  assert.equal(h.controller.getState().slots, slots);
  await h.controller.openChest();
  assert.deepEqual(
    h.calls.select.map((args) => args[0]),
    ['session-1', 'session-2'],
  );
  assert.equal(h.controller.getState().slots.length, 40);
  h.controller.dispose();
});

test('retry uses an already received prize without issuing a second selection', async () => {
  const clips = deferred();
  let attempts = 0;
  const h = harness({ open: () => (++attempts === 1 ? clips.promise : Promise.resolve()) });
  await h.controller.initialize();
  const opening = h.controller.openChest();
  await flush();
  clips.reject(new Error('Animation failed'));
  await opening;
  assert.equal(h.controller.getState().phase, 'failed');
  assert.equal(h.controller.getState().failure.recovery, 'open');
  await h.controller.retry();
  assert.equal(h.controller.getState().phase, 'prize-visible');
  assert.equal(h.calls.select.length, 1);
  assert.equal(h.calls.resetChest.length, 1);
  assert.equal(h.controller.getState().sessionId, 'session-1');
  h.controller.dispose();
});

test('retry after transport failure uses the same session id and blocks duplicate retry', async () => {
  const response = deferred();
  let attempts = 0;
  const h = harness({
    select: () =>
      ++attempts === 1 ? Promise.reject(new Error('Network failed')) : response.promise,
  });
  await h.controller.initialize();
  await h.controller.openChest();
  assert.equal(h.controller.getState().phase, 'failed');
  assert.equal(h.calls.spin, undefined);
  const retry = h.controller.retry();
  await h.controller.retry();
  await flush();
  assert.deepEqual(
    h.calls.select.map((args) => args[0]),
    ['session-1', 'session-1'],
  );
  response.resolve(legacyCatalog()[13]);
  await retry;
  assert.equal(h.controller.getState().phase, 'prize-visible');
  h.controller.dispose();
});

test('invalid catalog cancels preparation and allows retry initialization', async () => {
  let attempts = 0;
  const h = harness({ load: async () => (++attempts === 1 ? [] : legacyCatalog()) });
  await h.controller.initialize();
  const state = h.controller.getState();
  assert.equal(state.phase, 'failed');
  assert.equal(state.failure.code, 'EMPTY_CATALOG');
  assert.equal(state.failure.recovery, 'initialize');
  assert.ok(h.signals.every((signal) => signal.aborted));
  await h.controller.retry();
  assert.equal(h.controller.getState().phase, 'ready');
  assert.equal(h.calls.load.length, 2);
  h.controller.dispose();
});

test('invalid prize cannot produce a spin or visible win', async () => {
  const h = harness({ select: async () => item('14', 0, { rarity: 'unsupported' }) });
  await h.controller.initialize();
  await h.controller.openChest();
  assert.equal(h.controller.getState().phase, 'failed');
  assert.equal(h.controller.getState().failure.code, 'INVALID_ITEM');
  assert.equal(h.calls.spin, undefined);
  await h.controller.resetAfterError();
  assert.equal(h.controller.getState().phase, 'ready');
  h.controller.dispose();
});

test('late animation completion from a failed opening cannot change a reset session', async () => {
  const clips = deferred();
  const h = harness({
    select: async () => {
      throw new Error('Offline');
    },
    open: () => clips.promise,
  });
  await h.controller.initialize();
  await h.controller.openChest();
  await h.controller.resetAfterError();
  assert.equal(h.controller.getState().phase, 'ready');
  const snapshot = h.controller.getState();
  clips.resolve();
  await flush();
  assert.equal(h.controller.getState(), snapshot);
  assert.equal(h.calls.spin, undefined);
  h.controller.dispose();
});

test('reset failure retries reset without replaying selection or opening', async () => {
  let attempts = 0;
  const h = harness({
    resetChest: async () => {
      if (++attempts === 1) throw new Error('Reset failed');
    },
  });
  await h.controller.initialize();
  await h.controller.openChest();
  await h.controller.closePrize();
  assert.equal(h.controller.getState().phase, 'failed');
  assert.equal(h.controller.getState().failure.recovery, 'reset');
  await h.controller.retry();
  assert.equal(h.controller.getState().phase, 'ready');
  assert.equal(h.calls.select.length, 1);
  assert.equal(h.calls.open.length, 1);
  h.controller.dispose();
});

test('dispose settles pending operations even when adapters ignore cancellation', async () => {
  const prize = deferred();
  const h = harness({ select: () => prize.promise });
  await h.controller.initialize();
  const opening = h.controller.openChest();
  await flush();
  h.controller.dispose();
  await opening;
  assert.equal(h.controller.getState().phase, 'disposed');
  assert.ok(h.signals.every((signal) => signal.aborted));
  const state = h.controller.getState();
  prize.resolve(legacyCatalog()[13]);
  await flush();
  assert.equal(h.controller.getState(), state);
  assert.equal(h.calls.spin, undefined);
  await h.controller.initialize();
  await h.controller.retry();
  await h.controller.openChest();
  h.controller.dispose();
  assert.equal(h.calls.disposeChest.length, 1);
  assert.equal(h.calls.disposeRoulette.length, 1);
  assert.equal(h.calls.disposeTransitions.length, 1);
});

test('dispose during loading prevents drop and releases all prepared adapters', async () => {
  const catalog = deferred();
  const h = harness({ load: () => catalog.promise });
  const loading = h.controller.initialize();
  await flush();
  h.controller.dispose();
  await loading;
  catalog.resolve(legacyCatalog());
  await flush();
  assert.equal(h.controller.getState().phase, 'disposed');
  assert.equal(h.calls.drop, undefined);
});

test('a failing disposer does not skip remaining cleanup and disposal stays terminal', async () => {
  const h = harness({
    disposeChest: () => {
      throw new Error('Cleanup failed');
    },
  });
  await h.controller.initialize();
  assert.throws(() => h.controller.dispose(), AggregateError);
  assert.equal(h.controller.getState().phase, 'disposed');
  assert.equal(h.calls.disposeRoulette.length, 1);
  assert.equal(h.calls.disposeTransitions.length, 1);
  h.controller.dispose();
});

test('snapshots are stable and deeply immutable; unsubscribed views receive no updates', async () => {
  const h = harness();
  assert.equal(h.controller.getState(), h.controller.getState());
  let notifications = 0;
  const unsubscribe = h.controller.subscribe(() => (notifications += 1));
  await h.controller.initialize();
  assert.equal(notifications, 2);
  const state = h.controller.getState();
  assert.throws(() => {
    state.catalog[0].title = 'Changed';
  }, TypeError);
  assert.throws(() => {
    state.phase = 'disposed';
  }, TypeError);
  unsubscribe();
  await h.controller.openChest();
  assert.equal(notifications, 2);
  h.controller.dispose();
});

test('disposing from a state subscription prevents new adapter work', async () => {
  const h = harness();
  await h.controller.initialize();
  h.controller.subscribe(() => {
    if (h.controller.getState().phase === 'clearing') h.controller.dispose();
  });
  await h.controller.openChest();
  assert.equal(h.controller.getState().phase, 'disposed');
  assert.equal(h.calls.select, undefined);
  assert.equal(h.calls.open, undefined);
});

test('100 cycles keep catalog cached, preserve inserted slots and issue one result per opening', async () => {
  const h = harness();
  await h.controller.initialize();
  for (let i = 0; i < 100; i += 1) {
    await h.controller.openChest();
    assert.equal(h.controller.getState().phase, 'prize-visible');
    assert.equal(h.controller.getState().slots.length, 40);
    await h.controller.closePrize();
  }
  assert.equal(h.calls.load.length, 1);
  assert.equal(h.calls.select.length, 100);
  assert.equal(new Set(h.calls.select.map((args) => args[0])).size, 100);
  assert.equal(h.calls.drop.length, 100);
  assert.equal(h.controller.getState().phase, 'ready');
  h.controller.dispose();
});

test('drop waits for staging even after content has left the screen', async () => {
  const staged = deferred();
  const h = harness({ stageForDrop: () => staged.promise });
  await h.controller.initialize();
  const opening = h.controller.openChest();
  await flush();
  assert.equal(h.controller.getState().phase, 'clearing');
  assert.equal(h.calls.drop, undefined);
  staged.resolve();
  await opening;
  assert.equal(h.calls.drop.length, 1);
  h.controller.dispose();
});

function memoryJournal(initial) {
  let checkpoint = initial;
  return {
    load: () => checkpoint,
    save: (value) => {
      checkpoint = value;
    },
    clear: () => {
      checkpoint = undefined;
    },
  };
}

test('reload during the chest scene preserves session id and an already selected prize', async () => {
  const journal = memoryJournal(),
    landing = deferred();
  const first = harness({ journal, drop: () => landing.promise });
  await first.controller.initialize();
  const opening = first.controller.openChest();
  await flush();
  const checkpoint = journal.load();
  assert.equal(checkpoint.stage, 'chest');
  assert.equal(checkpoint.outcome.prize.id, legacyCatalog()[13].id);
  first.controller.dispose();
  await opening;
  const restored = harness({ journal });
  await restored.controller.initialize();
  assert.equal(restored.controller.getState().phase, 'prize-visible');
  assert.equal(restored.controller.getState().sessionId, checkpoint.sessionId);
  assert.equal(restored.calls.select, undefined);
  assert.equal(restored.controller.getState().selection.prize.id, checkpoint.outcome.prize.id);
  restored.controller.dispose();
});

test('pending selection is recovered with the same session id', async () => {
  const journal = memoryJournal({ stage: 'chest', sessionId: 'original-session' });
  const restored = harness({ journal });
  await restored.controller.initialize();
  assert.equal(restored.calls.select[0][0], 'original-session');
  assert.equal(restored.controller.getState().sessionId, 'original-session');
  restored.controller.dispose();
});

test('reload during roulette reuses the exact strip and spin plan, without another fall or selection', async () => {
  const journal = memoryJournal(),
    spin = deferred();
  const first = harness({ journal, spin: () => spin.promise });
  await first.controller.initialize();
  const opening = first.controller.openChest();
  await flush();
  const checkpoint = journal.load();
  assert.equal(checkpoint.stage, 'roulette');
  first.controller.dispose();
  await opening;
  const restored = harness({ journal });
  await restored.controller.initialize();
  assert.equal(restored.calls.drop, undefined);
  assert.equal(restored.calls.select, undefined);
  assert.deepEqual(restored.calls.spin[0][0], checkpoint.selection);
  assert.deepEqual(restored.calls.spin[0][1], checkpoint.plan);
  restored.controller.dispose();
});

test('revealed reward survives reload and Close clears the recovery journal', async () => {
  const journal = memoryJournal(),
    first = harness({ journal });
  await first.controller.initialize();
  await first.controller.openChest();
  const checkpoint = journal.load();
  assert.equal(checkpoint.stage, 'prize');
  first.controller.dispose();
  const restored = harness({ journal });
  await restored.controller.initialize();
  assert.equal(restored.controller.getState().phase, 'prize-visible');
  assert.equal(restored.calls.select, undefined);
  assert.equal(restored.calls.spin, undefined);
  await restored.controller.closePrize();
  assert.equal(journal.load(), undefined);
  restored.controller.dispose();
});

test('the owner hears when the outcome is on screen, not before', async () => {
  const revealed = [],
    spin = deferred();
  const h = harness({ spin: () => spin.promise, ownership: { reveal: (id) => revealed.push(id) } });
  await h.controller.initialize();
  const opening = h.controller.openChest();
  await flush();
  assert.deepEqual(revealed, [], 'the roulette is still spinning');
  spin.resolve();
  await opening;
  assert.deepEqual(revealed, ['session-1']);
  h.controller.dispose();
});

test('a refused opening never starts the fall', async () => {
  const h = harness({
    select: async () => {
      throw new Error('Not owned');
    },
  });
  await h.controller.initialize();
  await h.controller.openChest();
  assert.equal(h.controller.getState().phase, 'failed');
  assert.equal(h.calls.drop, undefined);
  h.controller.dispose();
});

test('a chest destroyed on impact ends the session after the fall: no opening, no prize, no roulette', async () => {
  const revealed = [];
  const h = harness({
    select: async () => ({ destroyed: 'impact' }),
    ownership: { reveal: (id) => revealed.push(id) },
  });
  await h.controller.initialize();
  await h.controller.openChest();
  assert.equal(h.controller.getState().phase, 'destroyed');
  assert.equal(h.calls.drop.length, 1);
  assert.equal(h.calls.open, undefined, 'nothing is left to open');
  assert.equal(h.calls.spin, undefined);
  assert.deepEqual(revealed, ['session-1']);
  await h.controller.closePrize();
  assert.equal(h.controller.getState().phase, 'ready');
});

test('a chest destroyed while opening bursts first, then shows the destruction; the journal restores it without asking again', async () => {
  let saved;
  const journal = {
    load: () => saved,
    save: (value) => {
      saved = value;
    },
    clear: () => {
      saved = undefined;
    },
  };
  const h = harness({ select: async () => ({ destroyed: 'opening' }), journal });
  await h.controller.initialize();
  await h.controller.openChest();
  assert.equal(h.controller.getState().phase, 'destroyed');
  assert.equal(h.calls.open.length, 1, 'the energy burst plays during the opening');
  assert.equal(h.calls.spin, undefined);
  assert.deepEqual(saved, { stage: 'destroyed', sessionId: 'session-1' });
  const restored = harness({ journal });
  await restored.controller.initialize();
  assert.equal(restored.controller.getState().phase, 'destroyed');
  assert.equal(restored.calls.drop, undefined, 'a decided destruction is shown, not replayed');
  assert.equal(restored.calls.select, undefined);
});

test('an outcome that is neither a prize nor a destruction never starts the fall', async () => {
  const h = harness({ select: async () => ({ destroyed: 'sideways' }) });
  await h.controller.initialize();
  await h.controller.openChest();
  assert.equal(h.controller.getState().phase, 'failed');
  assert.equal(h.controller.getState().failure.code, 'INVALID_OUTCOME');
  assert.equal(h.calls.drop, undefined);
  h.controller.dispose();
});

test('a damaged prize keeps its state through the reveal and a reload; an unknown state is refused', async () => {
  const journal = memoryJournal();
  const first = harness({
    journal,
    select: async () => ({ prize: legacyCatalog()[13], condition: 'heavy' }),
  });
  await first.controller.initialize();
  await first.controller.openChest();
  assert.equal(first.controller.getState().phase, 'prize-visible');
  assert.equal(first.controller.getState().condition, 'heavy');
  assert.equal(journal.load().condition, 'heavy');
  first.controller.dispose();
  const restored = harness({ journal });
  await restored.controller.initialize();
  assert.equal(restored.controller.getState().condition, 'heavy');
  assert.equal(restored.calls.select, undefined);
  restored.controller.dispose();

  const intact = harness();
  await intact.controller.initialize();
  await intact.controller.openChest();
  assert.equal('condition' in intact.controller.getState(), false);
  intact.controller.dispose();

  const invalid = harness({
    select: async () => ({ prize: legacyCatalog()[13], condition: 'melted' }),
  });
  await invalid.controller.initialize();
  await invalid.controller.openChest();
  assert.equal(invalid.controller.getState().phase, 'failed');
  invalid.controller.dispose();
});
