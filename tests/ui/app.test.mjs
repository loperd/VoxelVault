import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { legacyCatalog } from '../helpers.mjs';

const build = pathToFileURL(resolve(process.env.MCROULETTE_UI_BUILD ?? '.test-build/src') + '/');
const require = createRequire(new URL('package.json', build));
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { App } = await import(new URL('adapters/inbound/react/App.js', build));

function source(state) {
  return {
    getState: () => state,
    subscribe: () => () => {},
    retry: async () => {},
    load: async () => {},
    initialize: async () => {},
    openChest: async () => {},
    closePrize: async () => {},
    resetAfterError: async () => {},
    dispose: () => {},
  };
}
const render = (catalog, session) =>
  renderToStaticMarkup(
    createElement(App, {
      catalog: source(catalog),
      session: session ? source(session) : undefined,
    }),
  );

test('loading announces progress and offers no premature opening command', () => {
  const html = render({ phase: 'loading', items: [] });
  assert.match(html, /role="status"/);
  assert.match(html, /Загружаем предметы/);
  assert.doesNotMatch(html, /Открыть сундук/);
});

test('a failed catalog shows retry instead of raw technical error details', () => {
  const html = render({ phase: 'failed', items: [], message: 'HTTP 503 at internal URL' });
  assert.match(html, /role="alert"/);
  assert.match(html, /Повторить/);
  assert.doesNotMatch(html, /HTTP 503/);
  assert.doesNotMatch(html, /Предметы в сундуке/);
});

test('a ready catalog renders all 14 items and rarity labels without pretending a scene exists', () => {
  const html = render({ phase: 'ready', items: legacyCatalog() });
  assert.equal((html.match(/<li /g) ?? []).length, 14);
  assert.match(html, /Vip/);
  assert.match(html, /King/);
  assert.match(html, /Легендарный/);
  assert.doesNotMatch(html, /Открыть сундук/);
});

test('a configured ready game exposes the Open command', () => {
  const html = render(
    { phase: 'ready', items: legacyCatalog() },
    { phase: 'ready', catalog: legacyCatalog(), slots: [] },
  );
  assert.match(html, /Открыть сундук/);
  assert.match(html, /Предметы в сундуке/);
});

test('spinning never reveals the authoritative prize before prize-visible', () => {
  const html = render(
    { phase: 'ready', items: legacyCatalog() },
    {
      phase: 'spinning',
      catalog: legacyCatalog(),
      slots: [],
      sessionId: 'a',
      selection: { prize: legacyCatalog()[13], slots: [], targetIndex: 0 },
      plan: {},
    },
  );
  assert.match(html, /Выбираем награду/);
  assert.doesNotMatch(html, /King/);
  assert.doesNotMatch(html, /Открыть сундук/);
});

test('the win screen displays only the selected prize and a Close command', () => {
  const html = render(
    { phase: 'ready', items: legacyCatalog() },
    {
      phase: 'prize-visible',
      catalog: legacyCatalog(),
      slots: [],
      sessionId: 'a',
      selection: { prize: legacyCatalog()[13], slots: [], targetIndex: 0 },
      plan: {},
    },
  );
  assert.match(html, /Ваша награда/);
  assert.match(html, /King/);
  assert.match(html, /Закрыть/);
  assert.doesNotMatch(html, /Vip/);
});

test('a damaged prize says so; a destroyed chest never promises a reward', () => {
  const damaged = render(
    { phase: 'ready', items: legacyCatalog() },
    {
      phase: 'prize-visible',
      catalog: legacyCatalog(),
      slots: [],
      sessionId: 'a',
      selection: { prize: legacyCatalog()[13], slots: [], targetIndex: 0 },
      plan: {},
      condition: 'heavy',
    },
  );
  assert.match(damaged, /King/);
  assert.match(damaged, /Состояние: Повреждён/);
  assert.match(damaged, /prize--damaged/);
  const intact = render(
    { phase: 'ready', items: legacyCatalog() },
    {
      phase: 'prize-visible',
      catalog: legacyCatalog(),
      slots: [],
      sessionId: 'a',
      selection: { prize: legacyCatalog()[13], slots: [], targetIndex: 0 },
      plan: {},
    },
  );
  assert.doesNotMatch(intact, /Состояние:/);
  const destroyed = render(
    { phase: 'ready', items: legacyCatalog() },
    { phase: 'destroyed', catalog: legacyCatalog(), slots: [], sessionId: 'a' },
  );
  assert.match(destroyed, /Награда не получена/);
  assert.doesNotMatch(destroyed, /Ваша награда/);
  assert.doesNotMatch(destroyed, /King/);
});

test('disposed applications render no stale catalog or commands', () => {
  assert.equal(render({ phase: 'disposed', items: [] }), '');
});
