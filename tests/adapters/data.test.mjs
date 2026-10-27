import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { FixtureCatalogGateway } from '../../src/adapters/outbound/data/fixture-catalog-gateway.ts';
import { FixtureOutcomeGateway } from '../../src/adapters/outbound/data/fixture-outcome-gateway.ts';
import { decodeCatalog, decodeItem } from '../../src/adapters/outbound/data/item-dto.ts';
import {
  normalizeBaseUrl,
  resolvePublicAsset,
} from '../../src/adapters/outbound/data/asset-url.ts';
import { buildStrip, ensureTarget } from '../../src/domain/strip.ts';
import { constantRandom, deferred, flush } from '../helpers.mjs';

const raw = JSON.parse(await readFile(new URL('../../public/items.json', import.meta.url), 'utf8'));
const selected = JSON.parse(
  await readFile(new URL('../../public/selected_prize.json', import.meta.url), 'utf8'),
);
const base = new URL('https://example.test/game/');
const response = (value) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const signal = () => new AbortController().signal;

test('real legacy JSON converts numeric ids, string weights and rarity to domain items', async () => {
  const catalog = decodeCatalog(raw, base);
  assert.equal(catalog.length, 14);
  assert.equal(catalog[0].id, '1');
  assert.equal(catalog[0].displayWeight, 25);
  assert.equal(catalog[13].rarity, 'legendary');
  assert.equal(catalog[13].image, 'https://example.test/game' + raw[13].image);
  assert.ok(Object.isFrozen(catalog));
  const prize = decodeItem(selected, base);
  const selection = ensureTarget(
    buildStrip(catalog, 40, constantRandom()),
    prize,
    constantRandom(),
  );
  assert.equal(selection.slots.length, 40);
  assert.equal(selection.slots[selection.targetIndex].item.title, 'King');
  for (const entry of raw) {
    await readFile(new URL('../../public' + entry.image, import.meta.url));
  }
});

test('public paths stay within deployment base and external HTTPS images remain external', () => {
  assert.equal(resolvePublicAsset('/static/a.png', base), 'https://example.test/game/static/a.png');
  assert.equal(resolvePublicAsset('static/a.png', base), 'https://example.test/game/static/a.png');
  assert.equal(resolvePublicAsset('https://cdn.test/a.png', base), 'https://cdn.test/a.png');
  assert.equal(resolvePublicAsset('//cdn.test/a.png', base), 'https://cdn.test/a.png');
  assert.equal(normalizeBaseUrl('https://example.test/game?foo=1#top').href, base.href);
  assert.throws(() => resolvePublicAsset('javascript:alert(1)', base), { code: 'INVALID_URL' });
  assert.throws(() => resolvePublicAsset('', base), { code: 'INVALID_URL' });
});

test('DTO validation does not coerce malformed ids, titles, weights or rarity', () => {
  for (const patch of [
    { id: true },
    { id: null },
    { id: NaN },
    { id: 1.5 },
    { chance: true },
    { chance: null },
    { chance: '' },
    { chance: 'NaN' },
    { chance: '0x10' },
    { title: 4 },
    { image: [] },
    { type: null },
  ]) {
    assert.throws(() => decodeItem({ ...raw[0], ...patch }, base), { code: 'INVALID_DTO' });
  }
  for (const patch of [
    { chance: -1 },
    { chance: Infinity },
    { title: '' },
    { type: 'unsupported' },
  ]) {
    assert.throws(() => decodeItem({ ...raw[0], ...patch }, base), { code: 'INVALID_ITEM' });
  }
  assert.throws(() => decodeCatalog({}, base), { code: 'INVALID_DTO' });
  assert.throws(() => decodeCatalog([], base), { code: 'EMPTY_CATALOG' });
  assert.throws(() => decodeCatalog([raw[0], { ...raw[0], id: '1' }], base), {
    code: 'DUPLICATE_ITEM',
  });
});

test('concurrent catalog loads share one request and cache immutable results', async () => {
  const pending = deferred();
  const calls = [];
  const gateway = new FixtureCatalogGateway(base, (url, init) => {
    calls.push({ url, init });
    return pending.promise;
  });
  const first = gateway.load(signal());
  const second = gateway.load(signal());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/game/items.json');
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  pending.resolve(response(raw));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(await gateway.load(signal()), a);
  assert.equal(calls.length, 1);
  assert.throws(() => {
    a[0].title = 'Changed';
  }, TypeError);
  gateway.dispose();
});

test('canceling one catalog consumer does not cancel another consumer or its cache', async () => {
  const pending = deferred();
  let fetchSignal;
  const gateway = new FixtureCatalogGateway(base, (_url, init) => {
    fetchSignal = init.signal;
    return pending.promise;
  });
  const firstAbort = new AbortController();
  const first = gateway.load(firstAbort.signal);
  const second = gateway.load(signal());
  firstAbort.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(fetchSignal.aborted, false);
  pending.resolve(response(raw));
  const catalog = await second;
  assert.equal(await gateway.load(signal()), catalog);
  gateway.dispose();
});

test('canceling all consumers aborts transport; a late old response cannot overwrite new data', async () => {
  const old = deferred();
  let attempts = 0,
    oldSignal;
  const newData = raw.map((entry, index) => (index === 0 ? { ...entry, title: 'Fresh' } : entry));
  const gateway = new FixtureCatalogGateway(base, (_url, init) => {
    if (++attempts === 1) {
      oldSignal = init.signal;
      return old.promise;
    }
    return Promise.resolve(response(newData));
  });
  const a = new AbortController(),
    b = new AbortController();
  const first = gateway.load(a.signal),
    second = gateway.load(b.signal);
  a.abort();
  b.abort();
  await Promise.all([
    assert.rejects(first, { name: 'AbortError' }),
    assert.rejects(second, { name: 'AbortError' }),
  ]);
  assert.equal(oldSignal.aborted, true);
  const fresh = await gateway.load(signal());
  old.resolve(response(raw));
  await flush();
  assert.equal(fresh[0].title, 'Fresh');
  assert.equal(await gateway.load(signal()), fresh);
  assert.equal(attempts, 2);
  gateway.dispose();
});

test('HTTP errors, bad JSON and invalid catalogs are not cached and allow a new request', async (t) => {
  for (const [name, bad, code] of [
    ['HTTP', () => new Response('Unavailable', { status: 503 }), 'HTTP_ERROR'],
    ['JSON', () => new Response('{'), 'INVALID_JSON'],
    ['schema', () => response({ items: raw }), 'INVALID_DTO'],
  ])
    await t.test(name, async () => {
      let attempts = 0;
      const gateway = new FixtureCatalogGateway(base, async () =>
        ++attempts === 1 ? bad() : response(raw),
      );
      await assert.rejects(gateway.load(signal()), { code });
      assert.equal((await gateway.load(signal())).length, 14);
      assert.equal(attempts, 2);
      gateway.dispose();
    });
});

test('disposing the gateway settles a transport that ignores abort and prevents further loads', async () => {
  const pending = deferred();
  const gateway = new FixtureCatalogGateway(base, () => pending.promise);
  const loading = gateway.load(signal());
  gateway.dispose();
  await assert.rejects(loading, { name: 'AbortError' });
  await assert.rejects(gateway.load(signal()), /disposed/);
  pending.resolve(response(raw));
  await flush();
});

test('an already aborted caller cannot start a request or read the catalog cache', async () => {
  let calls = 0;
  const gateway = new FixtureCatalogGateway(base, async () => {
    calls++;
    return response(raw);
  });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(gateway.load(abort.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
  await gateway.load(signal());
  await assert.rejects(gateway.load(abort.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
  gateway.dispose();
});

test('each prize selection makes a fresh no-store request, including the same session retry', async () => {
  const calls = [];
  const gateway = new FixtureOutcomeGateway(base, async (url, init) => {
    calls.push({ url, init });
    return response({ ...selected, title: `Result ${calls.length}` });
  });
  for (const [index, id] of ['session-a', 'session-a', 'session-b'].entries()) {
    const { prize } = await gateway.decide(id, signal());
    assert.equal(prize.title, `Result ${index + 1}`);
    assert.equal(prize.id, '14');
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.url === 'https://example.test/game/selected_prize.json'));
  assert.ok(calls.every((call) => call.init.cache === 'no-store'));
});

test('canceling a prize response body settles immediately instead of producing a result', async () => {
  const body = deferred();
  const gateway = new FixtureOutcomeGateway(base, async () => ({
    ok: true,
    json: () => body.promise,
  }));
  const abort = new AbortController();
  const selection = gateway.decide('session', abort.signal);
  await flush();
  abort.abort();
  await assert.rejects(selection, { name: 'AbortError' });
  body.resolve(selected);
  await flush();
});
