import assert from 'node:assert/strict';
import test from 'node:test';
import { MAIN_SCREEN, parentRoute } from '../../src/application/navigation-map.ts';

test('back walks one step up the single map and stops at the main screen; it never leads to the archive', () => {
  assert.equal(MAIN_SCREEN, 'inventory');
  assert.equal(parentRoute({ screen: 'inventory' }), undefined);
  const routes = [
    { screen: 'catalog' },
    { screen: 'archive' },
    { screen: 'items' },
    { screen: 'not-found' },
    { screen: 'case', caseId: 'ender', instanceId: 'a' },
    { screen: 'item', caseId: 'ender', instanceId: 'a', itemId: 'x' },
    { screen: 'opening', caseId: 'ender', instanceId: 'a', sessionId: 's' },
    { screen: 'reward', caseId: 'ender', instanceId: 'a', sessionId: 's' },
  ];
  for (const route of routes) {
    let current = route,
      steps = 0;
    while (current && steps++ < 5) {
      assert.notEqual(parentRoute(current)?.screen, 'archive');
      current = parentRoute(current);
    }
    assert.ok(steps <= 4, `${route.screen} reaches the main screen`);
  }
  assert.deepEqual(parentRoute({ screen: 'item', caseId: 'ender', instanceId: 'a', itemId: 'x' }), {
    screen: 'case',
    caseId: 'ender',
    instanceId: 'a',
  });
  assert.deepEqual(
    parentRoute({ screen: 'reward', caseId: 'ender', instanceId: 'a', sessionId: 's' }),
    { screen: 'case', caseId: 'ender', instanceId: 'a' },
  );
});

test('a case entered from a list leads back to that list', () => {
  for (const returnTo of ['archive', 'catalog'])
    assert.deepEqual(parentRoute({ screen: 'case', caseId: 'ender', returnTo }), {
      screen: returnTo,
    });
});
