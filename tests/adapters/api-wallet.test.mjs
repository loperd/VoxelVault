import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiWallet } from '../../src/adapters/outbound/data/api-wallet.ts';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const balance = { asset: 'currency', posted: '9007199254740993', held: '4', available: '9007199254740989' };

test('Wallet retains exact posted, held and available amounts independently of Inventory', async () => {
  const calls = [];
  const wallet = new ApiWallet('https://example.test/', async (url, init) => { calls.push([new URL(url).pathname, init.credentials]); return json({ balances: [balance] }); });
  wallet.reset(); await wallet.load();
  assert.deepEqual(wallet.getState().balances, [balance]);
  assert.deepEqual(calls, [['/api/v1/wallet', 'same-origin']]);
});

test('invalid ledger balances and outages never fall back to the legacy wallet', async () => {
  for (const response of [() => json({}, 503), () => json({ balances: [{ ...balance, available: '9007199254740990' }] }), () => json({ balances: [{ ...balance, posted: 9007199254740993 }] })]) {
    let reads = 0;
    const wallet = new ApiWallet('https://example.test/', async () => { reads++; return response(); });
    wallet.reset(); await assert.rejects(wallet.load());
    assert.equal(reads, 1); assert.equal(wallet.getState().loaded, false);
  }
});

test('an old account response cannot repopulate Wallet after reset', async () => {
  let release;
  const wallet = new ApiWallet('https://example.test/', () => new Promise(resolve => { release = resolve; }));
  wallet.reset(); const read = wallet.load(); wallet.reset();
  release(json({ balances: [balance] })); await read;
  assert.equal(wallet.getState().loaded, false); assert.deepEqual(wallet.getState().balances, []);
});

test('Wallet history preserves exact units and binds pagination to the selected asset', async () => {
  const calls = [];
  const entry = { id: 'entry', asset: 'currency', units: '9007199254740993', direction: 'credit', purpose: 'opening_balance', reference: 'opening', at: '2026-10-23T00:00:00Z' };
  const wallet = new ApiWallet('https://example.test/', async (url, init) => { calls.push([new URL(url), init]); return json({ entries: [entry], nextCursor: 'next' }); });
  wallet.reset();
  assert.deepEqual(await wallet.history('currency', 'first'), { entries: [entry], nextCursor: 'next' });
  assert.equal(calls[0][0].searchParams.get('cursor'), 'first'); assert.equal(calls[0][1].credentials, 'same-origin');
});
