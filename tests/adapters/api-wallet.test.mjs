import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiWallet } from '../../src/adapters/outbound/data/api-wallet.ts';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const balance = {
  asset: 'currency',
  posted: '9007199254740993',
  held: '4',
  available: '9007199254740989',
};

const currency = {
  asset: 'currency',
  name: 'Монеты',
  code: 'VVC',
  precision: 0,
  canOperate: true,
};

test('Wallet retains exact posted, held and available amounts independently of Inventory', async () => {
  const calls = [];
  const wallet = new ApiWallet('https://example.test/', async (url, init) => {
    calls.push([new URL(url).pathname, init.credentials]);
    return json({ balances: [balance], currencies: [currency] });
  });
  wallet.reset();
  await wallet.load();
  assert.deepEqual(wallet.getState().balances, [balance]);
  assert.deepEqual(calls, [['/api/v1/wallet', 'same-origin']]);
});

test('invalid ledger balances and outages never fall back to the legacy wallet', async () => {
  for (const response of [
    () => json({}, 503),
    () =>
      json({ balances: [{ ...balance, available: '9007199254740990' }], currencies: [currency] }),
    () => json({ balances: [{ ...balance, posted: 9007199254740993 }], currencies: [currency] }),
  ]) {
    let reads = 0;
    const wallet = new ApiWallet('https://example.test/', async () => {
      reads++;
      return response();
    });
    wallet.reset();
    await assert.rejects(wallet.load());
    assert.equal(reads, 1);
    assert.equal(wallet.getState().loaded, false);
  }
});

test('an old account response cannot repopulate Wallet after reset', async () => {
  let release;
  const wallet = new ApiWallet(
    'https://example.test/',
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  wallet.reset();
  const read = wallet.load();
  wallet.reset();
  release(json({ balances: [balance], currencies: [currency] }));
  await assert.rejects(read, /Аккаунт изменён/);
  assert.equal(wallet.getState().loaded, false);
  assert.deepEqual(wallet.getState().balances, []);
});

test('Wallet history preserves exact units and binds pagination to the selected asset', async () => {
  const calls = [];
  const entry = {
    id: 'entry',
    status: 'credited',
    asset: 'currency',
    units: '9007199254740993',
    direction: 'credit',
    purpose: 'opening_balance',
    reference: 'opening',
    at: '2026-10-23T00:00:00Z',
  };
  const wallet = new ApiWallet('https://example.test/', async (url, init) => {
    calls.push([new URL(url), init]);
    return json({ entries: [entry], nextCursor: 'next' });
  });
  wallet.reset();
  assert.deepEqual(await wallet.history('currency', 'first'), {
    entries: [entry],
    nextCursor: 'next',
  });
  assert.equal(calls[0][0].searchParams.get('cursor'), 'first');
  assert.equal(calls[0][1].credentials, 'same-origin');
});

const transferQuote = {
  id: 'quote-1',
  recipient: { id: 'bob', handle: 'bob', displayName: 'Bob' },
  currencyId: 'currency',
  code: 'VVC',
  precision: 0,
  originalUnits: '100',
  debitUnits: '100',
  receiptUnits: '99',
  commission: [
    {
      ruleId: 'general-tax',
      version: '1',
      imposition: 'inside',
      units: '1',
      allocation: [{ accountRef: 'treasury', units: '1' }],
    },
  ],
  ruleVersion: '1',
  expiresAt: '2026-10-27T12:01:00Z',
};

test('transfer sends only quote inputs and reuses the same confirmation key', async () => {
  const calls = [];
  const wallet = new ApiWallet('https://example.test/', async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    if (path.endsWith('/recipient')) return json(transferQuote.recipient);
    if (path.endsWith('/quotes')) return json(transferQuote, 201);
    return json({
      transferId: 'quote-1',
      journalId: 'journal-1',
      currencyId: 'currency',
      state: 'committed',
      debitUnits: '100',
      receiptUnits: '99',
    });
  });
  const recipient = await wallet.resolveRecipient('currency', 'bob');
  const quote = await wallet.quoteTransfer('currency', recipient.id, '100');
  assert.equal(quote.receiptUnits, '99');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    asset: 'currency',
    recipient: 'bob',
    units: '100',
  });
  const receipt = await wallet.confirmTransfer(quote.id, 'same-key');
  await wallet.confirmTransfer(quote.id, 'same-key');
  assert.equal(receipt.state, 'committed');
  for (const { init } of calls.slice(2)) {
    assert.equal(init.headers['Idempotency-Key'], 'same-key');
    assert.deepEqual(JSON.parse(init.body), { quoteId: 'quote-1' });
    assert.equal(init.credentials, 'same-origin');
  }
});

test('a malformed quote, wrong recipient, or partial commission allocation is rejected', async () => {
  for (const change of [
    { receiptUnits: '100' },
    { recipient: { ...transferQuote.recipient, id: 'mallory' } },
    { precision: 19 },
    { commission: [{ ...transferQuote.commission[0], allocation: [] }] },
  ]) {
    const wallet = new ApiWallet('https://example.test/', async () =>
      json({ ...transferQuote, ...change }),
    );
    await assert.rejects(wallet.quoteTransfer('currency', 'bob', '100'));
  }
});

test('noncommitted receipts and transfer responses for a previous account are rejected', async () => {
  const pending = new ApiWallet('https://example.test/', async () =>
    json({ transferId: 'quote-1', state: 'pending' }),
  );
  await assert.rejects(pending.confirmTransfer('quote-1', 'key'));
  let release;
  const wallet = new ApiWallet(
    'https://example.test/',
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const quote = wallet.quoteTransfer('currency', 'bob', '100');
  wallet.reset();
  release(json(transferQuote));
  await assert.rejects(quote, /Аккаунт изменён/);
});

test('Wallet exposes an account revision that survives balance refresh and advances on reset', async () => {
  const wallet = new ApiWallet('https://example.test/', async () =>
    json({ balances: [balance], currencies: [currency] }),
  );
  const initial = wallet.getState().accountRevision;
  await wallet.load();
  assert.equal(wallet.getState().accountRevision, initial);
  wallet.reset();
  const changed = wallet.getState().accountRevision;
  assert.equal(changed, initial + 1);
  await wallet.load();
  assert.equal(wallet.getState().accountRevision, changed);
});

test('Wallet history requires explicit settlement status and never invents a legacy hold date', async () => {
  const held = {
    id: 'hold',
    asset: 'currency',
    direction: 'debit',
    units: '30',
    purpose: 'spending',
    reference: 'repair',
    status: 'held',
  };
  for (const entry of [
    held,
    { ...held, status: 'released' },
    { ...held, status: 'captured', at: '2026-10-27T00:00:00Z' },
    { ...held, status: 'credited', direction: 'credit', at: '2026-10-27T00:00:00Z' },
  ]) {
    const wallet = new ApiWallet('https://example.test/', async () => json({ entries: [entry] }));
    assert.deepEqual((await wallet.history('currency')).entries, [entry]);
  }
  for (const entry of [
    { ...held, status: 'pending' },
    { ...held, status: 'captured' },
    { ...held, status: 'credited', direction: 'debit' },
    { ...held, status: undefined },
  ]) {
    const wallet = new ApiWallet('https://example.test/', async () => json({ entries: [entry] }));
    await assert.rejects(wallet.history('currency'), /Invalid transaction/);
  }
});

test('Wallet handles non-JSON HTTP failures before parsing a successful DTO', async () => {
  for (const status of [401, 429, 502]) {
    const wallet = new ApiWallet(
      'https://example.test/',
      async () => new Response('<html>proxy error</html>', { status }),
    );
    await assert.rejects(
      wallet.load(),
      (error) =>
        error.code === 'HTTP_ERROR' && (status !== 429 || /Слишком много/.test(error.message)),
    );
  }
  const wallet = new ApiWallet(
    'https://example.test/',
    async () => new Response('broken', { status: 200 }),
  );
  await assert.rejects(
    wallet.load(),
    (error) => error.code === 'INVALID_JSON' && error.cause instanceof SyntaxError,
  );
});

test('Wallet rejects invisible formatting in a resolved recipient', async () => {
  const wallet = new ApiWallet('https://example.test/', async () =>
    json({ id: 'bob', handle: 'bob', displayName: 'Bob\u202e' }),
  );
  await assert.rejects(
    wallet.resolveRecipient('currency', 'bob'),
    (error) => error.code === 'INVALID_DTO',
  );
});

test('opaque handles retain the maximum-length account identity', async () => {
  const id = 'a'.repeat(160);
  const recipient = { id, handle: 'u_' + id, displayName: 'Player' };
  const wallet = new ApiWallet('https://example.test/', async () => json(recipient));
  assert.deepEqual(await wallet.resolveRecipient('currency', recipient.handle), recipient);
});
