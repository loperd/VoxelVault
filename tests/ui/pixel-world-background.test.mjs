import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const build = pathToFileURL(resolve(process.env.MCROULETTE_UI_BUILD ?? '.test-build/src') + '/');
const require = createRequire(new URL('package.json', build));
const { Window } = await import(pathToFileURL(require.resolve('happy-dom')));
const { act, createElement } = require('react');
const { createRoot } = require('react-dom/client');
const { PixelWorldBackground } = await import(
  new URL('adapters/inbound/react/PixelWorldBackground.js', build)
);

// Regression: the world was only made inside `onStatus?.(…)`, so a caller without onStatus got none
// and the chest waited for a world until it failed. No WebGL here: the attempt shows as the warning.
test('the world is made even when nobody listens for its status', async () => {
  const window = new Window({ url: 'https://example.test/' });
  window.HTMLCanvasElement.prototype.getContext = () => null;
  const saved = new Map();
  for (const name of ['window', 'document']) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: window[name === 'window' ? 'window' : name],
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const warnings = [],
    warn = console.warn;
  console.warn = (...args) => {
    warnings.push(String(args[0]));
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(PixelWorldBackground, { world: 'overworld' }));
    });
    assert.ok(
      warnings.some((text) => text.includes('The world is unavailable')),
      'the world was attempted',
    );
  } finally {
    console.warn = warn;
    await act(async () => {
      root.unmount();
    });
    await window.happyDOM.abort();
    window.close();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
