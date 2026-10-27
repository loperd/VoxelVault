import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiItems } from '../../src/adapters/outbound/data/api-items.ts';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const described = (id, type = 'rare') => ({
  id,
  title: id,
  image: `/api/v1/items/${id}/image.svg`,
  type,
  chance: 0,
});
const offers = {
  repair: { resource: 'deep-ore', value: 16 },
  salvage: { resource: 'deep-ore', value: 8 },
  sell: { resource: 'currency', value: 20 },
  mergeRepair: 70,
};

/** A stand-in for the items API: the list, and every POST recorded and answered. */
function itemsServer(state, answers = {}) {
  const requests = [];
  const json = (value, status = 200) => ({
    ok: status < 300,
    status,
    json: async () => structuredClone(value),
  });
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname.replace(/^.*\/api\/v1\/inventory\/items/, '');
    if (!init.method) return json(state);
    requests.push([path, init.method, init.credentials, JSON.parse(init.body)]);
    const answer = answers[path];
    if (typeof answer === 'function') return answer(state);
    return answer ? json(answer) : json({}, 409);
  };
  return { fetcher, requests };
}

test('items come with their prices; one the rulebook no longer describes is skipped', async () => {
  const server = itemsServer({
    items: [
      {
        id: 'a',
        item: described('mine-pick'),
        state: 'heavy',
        origin: 'c1',
        offers: { ...offers, mergeWith: 'z' },
      },
      {
        id: 'b',
        item: described('mine-pick'),
        state: 'intact',
        origin: 'c2',
        offers: { ...offers, repair: null },
      },
      {
        id: 'gone',
        item: { id: 'gone', title: 'gone', image: '/x.svg', type: '', chance: 0 },
        state: 'intact',
        origin: 'c3',
      },
    ],
    balances: { 'deep-ore': 30, currency: 5 },
  });
  const items = new ApiItems('https://example.test/', () => {}, server.fetcher);
  assert.equal(items.getState().loaded, false);
  await items.load();
  const { loaded, items: list, balances } = items.getState();
  assert.equal(loaded, true);
  assert.deepEqual(
    list.map((item) => [item.id, item.state, item.offers.repair?.value, item.offers.mergeWith]),
    [
      ['a', 'heavy', 16, 'z'],
      ['b', 'intact', undefined, undefined],
    ],
  );
  assert.equal(list[0].item.image, 'https://example.test/api/v1/items/mine-pick/image.svg');
  assert.equal(balances, undefined, 'Wallet is not part of Inventory state');
});

test('an action is a same-origin POST; the list is read again afterwards', async () => {
  const state = {
    items: [{ id: 'a b', item: described('mine-pick'), state: 'heavy', origin: 'c', offers }],
    balances: { 'deep-ore': 30 },
  };
  const server = itemsServer(state, {
    '/a%20b/repair': (current) => {
      current.items[0].state = 'slight';
      current.balances['deep-ore'] = 14;
      return { ok: true, status: 200, json: async () => ({ resource: 'deep-ore', value: 16 }) };
    },
  });
  const items = new ApiItems('https://example.test/', () => {}, server.fetcher);
  await items.load();
  assert.deepEqual(await items.work('a b', 'repair'), { resource: 'deep-ore', value: 16 });
  assert.deepEqual(server.requests, [['/a%20b/repair', 'POST', 'same-origin', {}]]);
  await settle();
  await settle();
  assert.equal(items.getState().items[0].state, 'slight');
  assert.equal(items.getState().balances, undefined);
});

test('a merge says whether the item that stayed was mended', async () => {
  const state = {
    items: [
      { id: 'a', item: described('mine-pick'), state: 'heavy', origin: 'c', offers },
      { id: 'b', item: described('mine-pick'), state: 'slight', origin: 'c', offers },
    ],
    balances: {},
  };
  const server = itemsServer(state, {
    '/merge': { id: 'b', item: described('mine-pick'), state: 'intact', origin: 'c' },
  });
  const items = new ApiItems('https://example.test/', () => {}, server.fetcher);
  await items.load();
  const result = await items.merge('a', 'b');
  assert.deepEqual([result.kept.id, result.kept.state, result.mended], ['b', 'intact', true]);
  assert.deepEqual(server.requests[0][3], { a: 'a', b: 'b' });
});

test('a refusal is reported, thrown, and the list read again', async () => {
  let reads = 0;
  const state = {
    items: [{ id: 'a', item: described('mine-pick'), state: 'heavy', origin: 'c', offers }],
    balances: {},
  };
  const server = itemsServer(state);
  const errors = [];
  const items = new ApiItems(
    'https://example.test/',
    (error) => errors.push(error),
    async (url, init) => {
      if (!init?.method) reads++;
      return server.fetcher(url, init);
    },
  );
  await items.load();
  await assert.rejects(items.work('a', 'repair'));
  await settle();
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(reads, 2);
});

test('a workshop waits for the saga and translates exact quoted units only on completion', async () => {
  const id = 'a'.repeat(64),
    requests = [];
  const op = {
    operationId: id,
    itemId: 'a',
    action: 'repair',
    stage: 'awaiting_funds',
    quote: { asset: 'deep-ore', units: '16' },
  };
  const items = new ApiItems(
    'https://example.test/',
    () => {},
    async (url, init = {}) => {
      requests.push([new URL(url).pathname, init]);
      if (init.method === 'POST') return new Response(JSON.stringify(op), { status: 202 });
      if (new URL(url).pathname.includes('/operations/'))
        return new Response(JSON.stringify({ ...op, stage: 'completed' }));
      return new Response(JSON.stringify({ items: [] }));
    },
  );
  assert.deepEqual(await items.work('a', 'repair'), { resource: 'deep-ore', value: 16 });
  assert.ok(requests[0][1].headers['Idempotency-Key']);
  assert.ok(requests.some(([path]) => path.endsWith(id)));
});

test('an uncertain POST reply retains its key when the player retries', async () => {
  const keys = [];
  let attempts = 0;
  const items = new ApiItems(
    'https://example.test/',
    () => {},
    async (_url, init = {}) => {
      if (!init.method) return new Response(JSON.stringify({ items: [] }));
      keys.push(init.headers['Idempotency-Key']);
      if (++attempts === 1) throw new Error('lost reply');
      return new Response(JSON.stringify({ resource: 'deep-ore', value: 16 }));
    },
  );
  await assert.rejects(items.work('a', 'repair'));
  await items.work('a', 'repair');
  assert.equal(keys[0], keys[1]);
});

test('canceled or unresolved operations are not reported as successful purchases', async () => {
  for (const stage of ['canceled', 'restored', 'reconciliation_required']) {
    const items = new ApiItems(
      'https://example.test/',
      () => {},
      async (_url, init = {}) =>
        new Response(
          JSON.stringify(
            init.method
              ? {
                  operationId: 'b'.repeat(64),
                  itemId: 'a',
                  action: 'sell',
                  stage,
                  quote: { asset: 'currency', units: '20' },
                }
              : { items: [] },
          ),
          { status: init.method ? 202 : 200 },
        ),
    );
    await assert.rejects(items.work('a', 'sell'), (error) =>
      ['OPERATION_REJECTED', 'OPERATION_PENDING'].includes(error.code),
    );
  }
});
