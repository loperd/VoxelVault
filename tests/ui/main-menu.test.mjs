import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const build = pathToFileURL(resolve(process.env.MCROULETTE_UI_BUILD ?? '.test-build/src') + '/');
const require = createRequire(new URL('package.json', build));
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { ErrorNotice } = await import(new URL('adapters/inbound/react/ErrorNotice.js', build));
const { NavigationContext } = await import(
  new URL('adapters/inbound/react/NavigationContext.js', build)
);

function notice(route) {
  const navigation = { getState: () => route, subscribe: () => () => {}, go() {} };
  return renderToStaticMarkup(
    createElement(
      NavigationContext.Provider,
      { value: { navigation } },
      createElement(ErrorNotice, { title: 'Connection unavailable' }),
    ),
  );
}

test('error screens offer the main menu from every inner route, including inventory items', () => {
  for (const screen of [
    'catalog',
    'archive',
    'items',
    'wallet',
    'case',
    'item',
    'opening',
    'reward',
    'not-found',
  ]) {
    assert.match(
      notice({ screen, caseId: 'ender', itemId: 'item', sessionId: 'session' }),
      /В главное меню/,
      screen,
    );
  }
});

test('an error on the main menu has no redundant main menu button', () => {
  assert.doesNotMatch(notice({ screen: 'inventory' }), /В главное меню/);
});
