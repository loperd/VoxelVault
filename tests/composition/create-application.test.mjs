import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createApplication } from '../../src/composition/create-application.ts';
import { constantRandom, deferred, flush } from '../helpers.mjs';

const items = JSON.parse(
  await readFile(new URL('../../public/items.json', import.meta.url), 'utf8'),
);
const prize = JSON.parse(
  await readFile(new URL('../../public/selected_prize.json', import.meta.url), 'utf8'),
);

function presentations() {
  const calls = {};
  const call = (name) => async () => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  return {
    calls,
    ports: {
      chest: {
        prepare: call('prepare'),
        drop: call('drop'),
        open: call('open'),
        hide: call('hide'),
        reset: call('resetChest'),
        dispose: () => {
          calls.disposeChest = (calls.disposeChest ?? 0) + 1;
        },
      },
      roulette: {
        prepare: call('prepareRoulette'),
        spin: call('spin'),
        reset: () => {},
        dispose: () => {
          calls.disposeRoulette = (calls.disposeRoulette ?? 0) + 1;
        },
      },
      transitions: {
        clearContent: call('clearContent'),
        flashToRoulette: call('flash'),
        finishFlash: call('finishFlash'),
        holdStoppedStrip: call('hold'),
        revealPrize: call('reveal'),
        resetToIntro: call('resetTransition'),
        dispose: () => {},
      },
    },
  };
}

test('the production composition loads a real catalog without inventing a game presentation', async () => {
  const requests = [];
  const app = createApplication({
    baseUrl: 'https://example.test/demo/',
    fetcher: async (url) => {
      requests.push(url);
      return new Response(JSON.stringify(items));
    },
  });
  await Promise.all([app.initialize(), app.initialize()]);
  assert.equal(app.catalog.getState().phase, 'ready');
  assert.equal(app.catalog.getState().items.length, 14);
  assert.equal(app.session, undefined);
  assert.deepEqual(requests, ['https://example.test/demo/items.json']);
  app.dispose();
  app.dispose();
  await app.initialize();
  assert.equal(app.catalog.getState().phase, 'disposed');
});

test('catalog and optional game share transport and connect the real prize gateway', async () => {
  const requests = [];
  const presentation = presentations();
  const app = createApplication({
    baseUrl: 'https://example.test/demo/',
    presentation: presentation.ports,
    random: constantRandom(),
    createSessionId: () => globalThis.crypto.randomUUID(),
    fetcher: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(url.endsWith('items.json') ? items : prize));
    },
  });
  await app.initialize();
  assert.equal(requests.length, 1);
  assert.equal(app.catalog.getState().phase, 'ready');
  assert.equal(app.session.getState().phase, 'ready');
  await app.session.openChest();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].init.cache, 'no-store');
  assert.equal(app.session.getState().selection.prize.title, 'King');
  assert.equal(app.session.getState().slots.length, 40);
  app.dispose();
  assert.equal(app.catalog.getState().phase, 'disposed');
  assert.equal(app.session.getState().phase, 'disposed');
  assert.equal(presentation.calls.disposeChest, 1);
  assert.equal(presentation.calls.disposeRoulette, 1);
});

test('composition cleanup cancels pending data and remains idempotent', async () => {
  const pending = deferred();
  let requestSignal;
  const app = createApplication({
    baseUrl: 'https://example.test/',
    fetcher: (_url, init) => {
      requestSignal = init.signal;
      return pending.promise;
    },
  });
  const loading = app.initialize();
  await flush();
  app.dispose();
  await loading;
  assert.equal(requestSignal.aborted, true);
  assert.equal(app.catalog.getState().phase, 'disposed');
  pending.resolve(new Response(JSON.stringify(items)));
  await flush();
  app.dispose();
});
