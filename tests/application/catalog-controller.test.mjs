import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogController } from '../../src/application/catalog-controller.ts';
import { deferred, flush, legacyCatalog } from '../helpers.mjs';

test('catalog loading is shared by repeated initialization and exposes immutable snapshots', async () => {
  const pending = deferred();
  let requests = 0;
  const catalog = new CatalogController({
    load: () => {
      requests++;
      return pending.promise;
    },
  });
  const phases = [];
  catalog.subscribe(() => phases.push(catalog.getState().phase));
  const first = catalog.load(),
    second = catalog.load();
  assert.equal(first, second);
  assert.equal(catalog.getState().phase, 'loading');
  const raw = legacyCatalog();
  pending.resolve(raw);
  await first;
  raw[0].title = 'Changed';
  assert.equal(catalog.getState().items[0].title, 'Vip');
  assert.equal(catalog.getState().phase, 'ready');
  assert.equal(requests, 1);
  assert.equal(catalog.getState(), catalog.getState());
  assert.deepEqual(phases, ['loading', 'ready']);
  await catalog.load();
  assert.equal(requests, 1);
  catalog.dispose();
});

test('catalog failure exposes retry and revalidates the next response', async () => {
  let requests = 0;
  const catalog = new CatalogController({
    load: async () => (++requests === 1 ? [] : legacyCatalog()),
  });
  await catalog.load();
  assert.equal(catalog.getState().phase, 'failed');
  assert.equal(catalog.getState().items.length, 0);
  await catalog.retry();
  assert.equal(catalog.getState().phase, 'ready');
  assert.equal(requests, 2);
  catalog.dispose();
});

test('catalog dispose cancels loading, unsubscribes views and ignores late results', async () => {
  const pending = deferred();
  let activeSignal;
  const catalog = new CatalogController({
    load: (signal) => {
      activeSignal = signal;
      return pending.promise;
    },
  });
  let notifications = 0;
  const unsubscribe = catalog.subscribe(() => notifications++);
  const loading = catalog.load();
  await flush();
  unsubscribe();
  catalog.dispose();
  await loading;
  assert.equal(activeSignal.aborted, true);
  assert.equal(catalog.getState().phase, 'disposed');
  assert.equal(notifications, 1);
  const state = catalog.getState();
  pending.resolve(legacyCatalog());
  await flush();
  assert.equal(catalog.getState(), state);
  await catalog.load();
  await catalog.retry();
  catalog.dispose();
  assert.equal(catalog.getState(), state);
});

test('disposing immediately from the loading notification prevents any network request', async () => {
  let requests = 0;
  const catalog = new CatalogController({
    load: async () => {
      requests++;
      return legacyCatalog();
    },
  });
  catalog.subscribe(() => {
    if (catalog.getState().phase === 'loading') catalog.dispose();
  });
  await catalog.load();
  assert.equal(requests, 0);
  assert.equal(catalog.getState().phase, 'disposed');
});
