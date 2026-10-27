import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../../worker/index.ts';

const env = {
  API_ORIGIN: 'https://api-voxelvault.mono.place',
  ASSETS: { fetch: async (request) => new Response(`asset ${new URL(request.url).pathname}`) },
};

test('the frontend Worker serves assets and proxies only /api/* to the API, keeping the browser origin', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, {
      status: 302,
      headers: {
        Location: 'https://oauth.telegram.org/auth?x=1',
        'Set-Cookie': 'vv_session=abc; Path=/; HttpOnly',
      },
    });
  };
  try {
    assert.equal(
      await (
        await worker.fetch(new Request('https://voxelvault.mono.place/inventory'), env)
      ).text(),
      'asset /inventory',
    );
    assert.equal(calls.length, 0);
    const response = await worker.fetch(
      new Request('https://voxelvault.mono.place/api/v1/auth/telegram/start?from=login', {
        headers: { Origin: 'https://voxelvault.mono.place', Cookie: 'vv_session=old' },
      }),
      env,
    );
    assert.equal(
      calls[0].url,
      'https://api-voxelvault.mono.place/api/v1/auth/telegram/start?from=login',
    );
    assert.equal(calls[0].init.redirect, 'manual', 'redirects reach the browser, not the Worker');
    assert.equal(calls[0].init.headers.get('Origin'), 'https://voxelvault.mono.place');
    assert.equal(calls[0].init.headers.get('Cookie'), 'vv_session=old');
    assert.equal(calls[0].init.headers.get('X-Forwarded-Host'), 'voxelvault.mono.place');
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), 'https://oauth.telegram.org/auth?x=1');
    assert.match(response.headers.get('Set-Cookie'), /vv_session=abc/);
    await worker.fetch(
      new Request('https://voxelvault.mono.place/api/v1/cases/ender/roll', {
        method: 'POST',
        body: '{"sessionId":"s"}',
        duplex: 'half',
      }),
      env,
    );
    assert.equal(calls[1].init.method, 'POST');
    assert.equal(await new Response(calls[1].init.body).text(), '{"sessionId":"s"}');
  } finally {
    globalThis.fetch = original;
  }
});
