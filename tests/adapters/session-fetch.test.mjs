import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionFetch } from '../../src/adapters/outbound/data/session-fetch.ts';

const REFRESH = 'https://vv.test/api/v1/auth/refresh';
const API = 'https://vv.test/api/v1/inventory';
/** A fake network: `answers[url]` is a list of statuses (the last repeats), or a function that throws. */
function network(answers) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    const list = answers[url];
    if (typeof list === 'function') return list();
    return new Response(null, { status: list.length > 1 ? list.shift() : list[0] });
  };
  return { fetcher, calls };
}

test('an expired access token is refreshed once and the call repeated', async () => {
  const { fetcher, calls } = network({ [API]: [401, 200], [REFRESH]: [200] });
  let expired = 0;
  const response = await sessionFetch(fetcher, REFRESH, () => expired++)(API);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [API, REFRESH, API]);
  assert.equal(expired, 0);
});

test('a refused refresh ends the session', async () => {
  const { fetcher } = network({ [API]: [401], [REFRESH]: [401] });
  let expired = 0;
  assert.equal((await sessionFetch(fetcher, REFRESH, () => expired++)(API)).status, 401);
  assert.equal(expired, 1);
});

test('calls that hit 401 together share one refresh', async () => {
  const { fetcher, calls } = network({ [API]: [401, 401, 200], [REFRESH]: [200] });
  const fetchSession = sessionFetch(fetcher, REFRESH, () => assert.fail('not expired'));
  await Promise.all([fetchSession(API), fetchSession(API)]);
  assert.equal(calls.filter((url) => url === REFRESH).length, 1);
});

test('no network for the refresh keeps the session; auth endpoints pass through', async () => {
  const { fetcher, calls } = network({
    [API]: [401],
    [REFRESH]: () => {
      throw new TypeError('offline');
    },
    'https://vv.test/api/v1/auth/logout': [401],
  });
  const fetchSession = sessionFetch(fetcher, REFRESH, () => assert.fail('not expired'));
  assert.equal((await fetchSession(API)).status, 401);
  assert.equal((await fetchSession('https://vv.test/api/v1/auth/logout')).status, 401);
  assert.deepEqual(calls, [API, REFRESH, 'https://vv.test/api/v1/auth/logout']);
});
