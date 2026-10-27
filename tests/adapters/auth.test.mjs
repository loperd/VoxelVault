import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApiAuthGateway,
  fromBase64Url,
  toBase64Url,
} from '../../src/adapters/outbound/data/api-auth-gateway.ts';

const base = 'https://example.test/game/';
const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const player = { id: 'u1', handle: 'steve', displayName: 'Стив', roles: ['player'] };
const challenge = toBase64Url(new Uint8Array([1, 2, 3, 250]).buffer);

function withPasskeys(run) {
  const previous = globalThis.PublicKeyCredential;
  globalThis.PublicKeyCredential = class {};
  return run().finally(() => {
    globalThis.PublicKeyCredential = previous;
  });
}
const credential = { id: 'cred', toJSON: () => ({ id: 'cred', type: 'public-key', response: {} }) };

test('base64url round-trips bytes the way WebAuthn options carry them', () => {
  const bytes = new Uint8Array([0, 255, 62, 63, 128]);
  assert.deepEqual(new Uint8Array(fromBase64Url(toBase64Url(bytes.buffer))), bytes);
  assert.doesNotMatch(toBase64Url(bytes.buffer), /[+/=]/);
});

test('current player: 401 means signed out, a network failure means the server is unavailable', async () => {
  assert.equal(await new ApiAuthGateway(base, async () => json(401, {})).current(), undefined);
  assert.deepEqual(await new ApiAuthGateway(base, async () => json(200, player)).current(), player);
  await assert.rejects(
    new ApiAuthGateway(base, async () => {
      throw new TypeError('offline');
    }).current(),
    (error) => error.code === 'UNAVAILABLE',
  );
  await assert.rejects(
    new ApiAuthGateway(base, async () => json(502, {})).current(),
    (error) => error.code === 'UNAVAILABLE',
  );
});

test('passkey sign-in: options, the browser prompt with binary challenge, then verify under the ceremony id', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/login/options')
      ? json(200, {
          ceremonyId: 'c-1',
          options: {
            publicKey: { challenge, allowCredentials: [{ type: 'public-key', id: challenge }] },
          },
        })
      : json(200, player);
  };
  let prompt;
  const credentials = {
    get: async (options) => {
      prompt = options;
      return credential;
    },
  };
  const result = await withPasskeys(() =>
    new ApiAuthGateway(base, fetcher, credentials).signIn('steve'),
  );
  assert.deepEqual(result, player);
  assert.equal(calls[0].url, 'https://example.test/game/api/v1/auth/passkeys/login/options');
  assert.deepEqual(JSON.parse(calls[0].init.body), { handle: 'steve' });
  assert.ok(prompt.publicKey.challenge instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(prompt.publicKey.challenge)], [1, 2, 3, 250]);
  assert.equal(calls[1].init.headers['X-Ceremony-ID'], 'c-1');
  assert.equal(JSON.parse(calls[1].init.body).id, 'cred');
  assert.ok(calls.every((call) => call.init.credentials === 'same-origin'));
});

test('passkey failures become reasons the login screen can explain', async () => {
  const options = async (url) =>
    url.endsWith('/options')
      ? json(200, {
          ceremonyId: 'c',
          options: {
            publicKey: { challenge, user: { id: challenge, name: 'a', displayName: 'a' } },
          },
        })
      : json(400, {});
  const cancelled = {
    create: async () => {
      throw new DOMException('closed', 'NotAllowedError');
    },
  };
  await withPasskeys(() =>
    assert.rejects(
      new ApiAuthGateway(base, options, cancelled).register('steve', 'Стив'),
      (error) => error.code === 'CANCELLED',
    ),
  );
  const accepted = { create: async () => credential };
  await withPasskeys(() =>
    assert.rejects(
      new ApiAuthGateway(base, options, accepted).register('steve', 'Стив'),
      (error) => error.code === 'REJECTED',
    ),
  );
  await assert.rejects(
    new ApiAuthGateway(base, async () => json(409, {})).register('steve', 'Стив'),
    (error) => error.code === 'HANDLE_TAKEN',
  );
  await assert.rejects(
    new ApiAuthGateway(base, async () => json(401, {})).signIn('nobody'),
    (error) => error.code === 'UNKNOWN_ACCOUNT',
  );
  // No WebAuthn in this browser: said plainly, before any prompt.
  const previous = globalThis.PublicKeyCredential;
  delete globalThis.PublicKeyCredential;
  try {
    await assert.rejects(
      new ApiAuthGateway(base, options, accepted).register('steve', 'Стив'),
      (error) => error.code === 'UNSUPPORTED',
    );
  } finally {
    if (previous) globalThis.PublicKeyCredential = previous;
  }
});

test('providers and the Telegram redirect come from the shared gateway', async () => {
  const gateway = new ApiAuthGateway(base, async () =>
    json(200, { passkeys: { enabled: true }, telegram: { enabled: true } }),
  );
  assert.deepEqual(await gateway.providers(), { passkey: true, telegram: true });
  assert.equal(gateway.telegramUrl, 'https://example.test/game/api/v1/auth/telegram/start');
});
