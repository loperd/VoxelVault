import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const build = pathToFileURL(resolve(process.env.MCROULETTE_UI_BUILD ?? '.test-build/src') + '/');
const require = createRequire(new URL('package.json', build));
const { Window } = await import(pathToFileURL(require.resolve('happy-dom')));
// react-dom decides once, at load, whether `input` events exist: load it with a DOM in place.
const bootstrap = new Window();
const hadDom = 'document' in globalThis;
Object.assign(globalThis, { window: bootstrap, document: bootstrap.document });
const { act, createElement } = require('react');
const { createRoot } = require('react-dom/client');
if (!hadDom) {
  delete globalThis.window;
  delete globalThis.document;
}
await bootstrap.happyDOM.abort();
bootstrap.close();
const { LoginScreen } = await import(new URL('adapters/inbound/react/LoginScreen.js', build));
const { AuthError } = await import(new URL('application/ports/auth-gateway.js', build));

let window, root;
const descriptors = new Map();
beforeEach(() => {
  window = new Window({
    url: 'https://example.test/',
    settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true },
  });
  for (const name of [
    'window',
    'document',
    'HTMLElement',
    'Node',
    'Event',
    'MouseEvent',
    'navigator',
  ]) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === 'window' ? window : window[name],
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await window.happyDOM.abort();
  window.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  descriptors.clear();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

const player = { id: 'u1', handle: 'steve', displayName: 'Стив', roles: ['player'] };
function fakeAuth(overrides = {}) {
  const calls = [];
  return {
    calls,
    telegramUrl: '/api/v1/auth/telegram/start',
    current: async () => undefined,
    providers: async () => ({ passkey: true, telegram: false }),
    signIn: async (handle) => {
      calls.push(['signIn', handle]);
      return player;
    },
    register: async (handle, name) => {
      calls.push(['register', handle, name]);
      return player;
    },
    signOut: async () => {},
    ...overrides,
  };
}
async function mount(auth, onSignedIn = () => {}) {
  await act(async () => root.render(createElement(LoginScreen, { auth, onSignedIn })));
}
async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
const submit = (form) =>
  act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });

test('signing in with a passkey sends the normalised handle and hands the player over', async () => {
  const auth = fakeAuth();
  let signedIn;
  await mount(auth, (value) => {
    signedIn = value;
  });
  const button = document.querySelector('button[type="submit"]');
  assert.equal(button.disabled, true, 'nothing to send before a handle is typed');
  await type(document.querySelector('input[name="username"]'), '  Steve ');
  assert.equal(document.querySelector('button[type="submit"]').disabled, false);
  await submit(document.querySelector('form'));
  assert.deepEqual(auth.calls, [['signIn', 'steve']]);
  assert.equal(signedIn, player);
});

test('an unknown handle switches to registration and explains it; a cancelled prompt is not an error page', async () => {
  const auth = fakeAuth({
    signIn: async () => {
      throw new AuthError('UNKNOWN_ACCOUNT', 'x');
    },
  });
  await mount(auth);
  await type(document.querySelector('input[name="username"]'), 'alex');
  await submit(document.querySelector('form'));
  assert.match(document.querySelector('[role="alert"]').textContent, /не найден/);
  assert.match(document.querySelector('h1').textContent, /Создать аккаунт/);
  assert.ok(
    document.querySelector('input[name="nickname"]'),
    'registration asks for a display name',
  );
  auth.register = async () => {
    throw new AuthError('CANCELLED', 'x');
  };
  await submit(document.querySelector('form'));
  assert.match(document.querySelector('[role="alert"]').textContent, /отменён/);
  assert.equal(
    document.querySelector('button[type="submit"]').disabled,
    false,
    'the player can try again',
  );
});

test('Telegram is offered only when the server has it configured', async () => {
  await mount(fakeAuth());
  assert.equal(document.querySelector('a[href="/api/v1/auth/telegram/start"]'), null);
  await act(async () => root.unmount());
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await mount(fakeAuth({ providers: async () => ({ passkey: true, telegram: true }) }));
  assert.match(
    document.querySelector('a[href="/api/v1/auth/telegram/start"]').textContent,
    /Telegram/,
  );
});
