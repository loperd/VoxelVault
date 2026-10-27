import assert from 'node:assert/strict';
import test from 'node:test';
import { loadedInventory, inventoryServer } from '../helpers.mjs';
import { ApiInventory } from '../../src/adapters/outbound/data/api-inventory.ts';
import { CASES } from '../../src/config/cases.ts';
import { chestLook } from '../../src/config/chest-look.ts';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const map = {
  id: 'traveler-map',
  title: 'Карта',
  image: 'images/map.webp',
  type: 'legendary',
  chance: 12,
};

test('exact unsigned seed strings retain their low 32 bits for visual appearance', async () => {
  const { inventory } = await loadedInventory([
    { id: 'large', caseId: 'traveler', seed: '9007199254740993' },
  ]);
  assert.deepEqual(
    inventory.getState()[0].appearance,
    chestLook(
      CASES.find((c) => c.id === 'traveler'),
      1,
      [],
    ),
  );
  await assert.rejects(
    loadedInventory([{ id: 'overflow', caseId: 'traveler', seed: '18446744073709551616' }]),
  );
});

test('chests come from the server with their contents; their look is the traits the server froze', async () => {
  const traveler = CASES.find((item) => item.id === 'traveler');
  const traits = [
    { id: 'body-cracks', intensity: 0.9, seed: 1 },
    { id: 'not-on-this-model', intensity: 0.5, seed: 2 },
  ];
  const { inventory } = await loadedInventory([
    {
      id: 'a',
      caseId: 'traveler',
      seed: 42,
      rarity: 'rare',
      condition: 0.4,
      contents: [{ item: map, weight: 10 }],
    },
    { id: 'b', caseId: 'traveler', seed: 9, traits },
    { id: 'c', caseId: 'some-future-type', seed: 1 },
  ]);
  const [a, b] = inventory.getState();
  assert.deepEqual(
    inventory.getState().map((chest) => chest.id),
    ['a', 'b'],
    'an unknown type is skipped',
  );
  assert.deepEqual(a.appearance, chestLook(traveler, 42, []), 'every client draws the same look');
  assert.equal(a.rarity, 'rare');
  assert.equal(a.condition, 0.4);
  assert.deepEqual(
    a.contents.map((slot) => [slot.item.id, slot.weight]),
    [['traveler-map', 10]],
  );
  assert.deepEqual(
    b.appearance.modifications.map((item) => [item.id, item.intensity, item.seed]),
    [['body-cracks', 0.9, 1]],
  );
});

test("opening claims then opens; the prize is the server's and shows in the list only once revealed", async () => {
  const { inventory, server, errors } = await loadedInventory(
    [{ id: 'a', caseId: 'traveler', seed: 3 }],
    { s1: map },
  );
  const opening = inventory.open('a', 's1');
  assert.equal(inventory.getState()[0].status, 'opening', 'shown at once');
  assert.equal((await opening).prize.id, 'traveler-map');
  assert.deepEqual(server.requests, [
    ['claim', 'a', 's1'],
    ['open', 'a', 's1'],
  ]);
  assert.equal(
    inventory.getState()[0].status,
    'opening',
    'no list shows the prize before the roulette does',
  );
  inventory.reveal('a');
  assert.equal(inventory.getState()[0].status, 'opened');
  assert.equal(inventory.getState()[0].reward.id, 'traveler-map');
  assert.equal(inventory.getState()[0].rewardState, 'intact');
  assert.deepEqual(errors, []);
});

test('claim and open are same-origin, no-store POSTs carrying the opening session', async () => {
  const server = inventoryServer([{ id: 'chest 7', caseId: 'traveler', seed: 3 }]),
    calls = [];
  const inventory = new ApiInventory(
    'https://example.test/game/',
    CASES,
    () => {},
    async (url, init) => {
      calls.push({ url, init });
      return server.fetcher(url, init);
    },
  );
  await inventory.load();
  await inventory.open('chest 7', 'session-a');
  assert.deepEqual(
    calls
      .slice(1)
      .map((call) => [
        call.url,
        call.init.method,
        call.init.credentials,
        call.init.cache,
        JSON.parse(call.init.body).sessionId,
      ]),
    [
      [
        'https://example.test/game/api/v1/inventory/chest%207/claim',
        'POST',
        'same-origin',
        'no-store',
        'session-a',
      ],
      [
        'https://example.test/game/api/v1/inventory/chest%207/open',
        'POST',
        'same-origin',
        'no-store',
        'session-a',
      ],
    ],
  );
});

test('the server decides destruction, on impact or while opening', async () => {
  const { inventory } = await loadedInventory(
    [
      { id: 'a', caseId: 'traveler', seed: 3 },
      { id: 'b', caseId: 'traveler', seed: 4 },
    ],
    { s1: { destroyed: 'impact' }, s2: { destroyed: 'opening' } },
  );
  assert.deepEqual(await inventory.open('a', 's1'), { destroyed: 'impact' });
  assert.deepEqual(await inventory.open('b', 's2'), { destroyed: 'opening' });
  inventory.reveal('a');
  inventory.reveal('b');
  assert.deepEqual(
    inventory.getState().map((chest) => [chest.status, chest.destroyedAt]),
    [
      ['destroyed', 'impact'],
      ['destroyed', 'opening'],
    ],
  );
});

test('opening again for the same session asks the server again and gets the same outcome', async () => {
  const { inventory } = await loadedInventory([{ id: 'a', caseId: 'traveler', seed: 3 }], {
    s1: map,
  });
  const first = await inventory.open('a', 's1');
  assert.deepEqual(await inventory.open('a', 's1'), first);
});

test('a refusal is reported and the list read again from the server', async () => {
  const server = inventoryServer([{ id: 'a', caseId: 'traveler', seed: 3 }]),
    errors = [];
  const refusing = async (url, init = {}) =>
    init.method ? { ok: false, status: 409, json: async () => ({}) } : server.fetcher(url, init);
  const inventory = new ApiInventory(
    'https://example.test/',
    CASES,
    (error) => errors.push(error),
    refusing,
  );
  await inventory.load();
  await assert.rejects(inventory.open('a', 's1'));
  await settle();
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(inventory.getState()[0].status, 'available', 'back to what the server has');
});

test('nothing about chests touches browser storage', async () => {
  const touched = [];
  globalThis.localStorage = new Proxy(
    {},
    {
      get: (_, key) => {
        touched.push(key);
        return () => null;
      },
    },
  );
  try {
    const { inventory } = await loadedInventory([{ id: 'a', caseId: 'traveler', seed: 3 }]);
    await inventory.open('a', 's1');
    inventory.reveal('a');
    assert.deepEqual(touched, []);
  } finally {
    delete globalThis.localStorage;
  }
});

test('a merge asks the server for its odds, then spends the pair into a new chest', async () => {
  const { inventory, server, errors } = await loadedInventory([
    { id: 'a', caseId: 'traveler', seed: 3, traits: [{ id: 'moss', intensity: 0.5, seed: 1 }] },
    {
      id: 'b',
      caseId: 'traveler',
      seed: 4,
      traits: [{ id: 'body-cracks', intensity: 0.4, seed: 2 }],
    },
    { id: 'c', caseId: 'ender', seed: 5 },
  ]);
  assert.deepEqual(await inventory.mergeOdds('a', 'b'), {
    traits: [
      { id: 'moss', keep: 40, upgrade: 0 },
      { id: 'body-cracks', keep: 0, upgrade: 0 },
    ],
    contents: { total: 12, kept: 8, keep: 66.67 },
  });
  await assert.rejects(inventory.mergeOdds('a', 'c'), /HTTP 409/);
  const merged = await inventory.merge('a', 'b');
  assert.equal(merged.caseId, 'traveler');
  assert.deepEqual(
    inventory.getState().map((chest) => chest.id),
    ['c', merged.id],
    "the list is the server's after the merge",
  );
  assert.deepEqual(
    server.requests.map((request) => request.slice(0, 1)),
    [['odds'], ['odds'], ['merge']],
  );
  await assert.rejects(inventory.merge('c', merged.id));
  assert.equal(errors.length, 1, 'a refused merge is reported');
});

test('merge odds that are not percents are refused', async () => {
  const server = inventoryServer([]);
  const lying = async (url, init) =>
    url.includes('/merge')
      ? {
          ok: true,
          status: 200,
          json: async () => ({
            traits: [{ id: 'moss', keep: 140, upgrade: 0 }],
            contents: { total: 2, kept: 1, keep: 50 },
          }),
        }
      : server.fetcher(url, init);
  const inventory = new ApiInventory('https://example.test/', CASES, () => {}, lying);
  await assert.rejects(inventory.mergeOdds('a', 'b'), /percent/);
});

test('clear forgets the list: a gone session leaves no chests to look at', async () => {
  const { inventory } = await loadedInventory([{ id: 'a', caseId: 'traveler', seed: 3 }]);
  assert.equal(inventory.getState().length, 1);
  inventory.clear();
  assert.deepEqual(inventory.getState(), []);
  assert.equal(inventory.isLoaded(), false, 'the next sign-in reads it again');
});
