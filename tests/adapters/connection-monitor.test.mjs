import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkConnection,
  createConnectionMonitor,
  watchedFetch,
} from '../../src/adapters/outbound/data/connection-monitor.ts';

const SERVER = '/api/v1/cases';
/** A fetcher where each URL answers with a status or is unreachable (undefined). */
const fetcherFor = (answers) => async (url) => {
  const status =
    answers[
      url.includes('gstatic') ? 'google' : url.includes('cloudflare') ? 'cloudflare' : 'server'
    ];
  if (status === undefined) throw new TypeError('Failed to fetch');
  return { status };
};

test('server answering means ok, even when the public hosts are blocked', async () => {
  assert.equal(await checkConnection(SERVER, fetcherFor({ server: 200 })), 'ok');
});

test('server silent while a public host answers means the server is down', async () => {
  assert.equal(await checkConnection(SERVER, fetcherFor({ cloudflare: 204 })), 'server-down');
  assert.equal(
    await checkConnection(SERVER, fetcherFor({ server: 503, google: 204 })),
    'server-down',
  );
});

test('nothing answering means the internet is down', async () => {
  assert.equal(await checkConnection(SERVER, fetcherFor({})), 'internet-down');
});

test('the monitor notifies, then re-checks until the connection is back', async () => {
  const results = ['server-down', 'server-down', 'ok'];
  const seen = [];
  const monitor = createConnectionMonitor(async () => results.shift(), 1);
  monitor.subscribe(() => seen.push(monitor.getState()));
  monitor.suspect();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(seen, ['server-down', 'ok']);
});

test('offline shows at once; a failed or 5xx request raises suspicion, an abort does not', async () => {
  const monitor = createConnectionMonitor(() => new Promise(() => {}));
  monitor.offline();
  assert.equal(monitor.getState(), 'internet-down');
  let troubles = 0;
  const count = () => troubles++;
  await watchedFetch(async () => ({ status: 502 }), count)('/x');
  await assert.rejects(watchedFetch(async () => Promise.reject(new TypeError('x')), count)('/x'));
  await assert.rejects(
    watchedFetch(async () => Promise.reject(new DOMException('a', 'AbortError')), count)('/x'),
  );
  await watchedFetch(async () => ({ status: 200 }), count)('/x');
  assert.equal(troubles, 2);
});
