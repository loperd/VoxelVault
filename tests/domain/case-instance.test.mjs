import assert from 'node:assert/strict';
import test from 'node:test';
import {
  copyCaseInstance,
  claimCase,
  isConsumed,
  nextOwnedCase,
} from '../../src/domain/case-instance.ts';
import { createChestAppearance } from '../../src/domain/chest-appearance.ts';
import { item } from '../helpers.mjs';

const fresh = (overrides = {}) =>
  copyCaseInstance({
    id: 'owned-1',
    caseId: 'ender',
    status: 'available',
    appearance: createChestAppearance(),
    contents: [
      { item: item('a', 60), weight: 40 },
      { item: item('b', 40), weight: 25 },
    ],
    traits: [{ id: 'moss', intensity: 0.5, seed: 3 }],
    rarity: 'uncommon',
    condition: 0.8,
    ...overrides,
  });
const opened = (id, sessionId) =>
  fresh({
    id,
    status: 'opened',
    sessionId,
    reward: item('prize'),
    rewardState: 'slight',
    openedAt: new Date(0).toISOString(),
  });

test('a chest is what the server says: contents, traits, rarity, condition, frozen', () => {
  const chest = fresh();
  assert.deepEqual(
    chest.contents.map((slot) => [slot.item.id, slot.weight]),
    [
      ['a', 40],
      ['b', 25],
    ],
  );
  assert.deepEqual(chest.traits, [{ id: 'moss', intensity: 0.5, seed: 3 }]);
  assert.equal(chest.rarity, 'uncommon');
  assert.equal(chest.condition, 0.8);
  assert.ok(
    Object.isFrozen(chest) && Object.isFrozen(chest.contents) && Object.isFrozen(chest.traits[0]),
  );
  assert.equal(opened('o', 's1').rewardState, 'slight');
  assert.deepEqual(
    copyCaseInstance(JSON.parse(JSON.stringify(opened('o', 's1')))),
    opened('o', 's1'),
  );
});

test('claiming shows one opening session at once; another session cannot take it', () => {
  const available = fresh(),
    opening = claimCase(available, 's1');
  assert.equal(available.status, 'available');
  assert.equal(opening.status, 'opening');
  assert.equal(claimCase(opening, 's1'), opening);
  assert.throws(
    () => claimCase(opening, 's2'),
    (error) => error.code === 'CASE_UNAVAILABLE',
  );
  assert.equal(
    claimCase(opened('o', 's1'), 's1').status,
    'opened',
    'the same session resumes, whatever the server did',
  );
  assert.throws(() => claimCase(opened('o', 's1'), 's3'));
});

test('a destroyed chest is consumed without a reward and knows when it broke', () => {
  const destroyed = fresh({ status: 'destroyed', sessionId: 's1', destroyedAt: 'impact' });
  assert.ok(isConsumed(destroyed));
  assert.equal(destroyed.reward, undefined);
  assert.throws(() => fresh({ status: 'destroyed', sessionId: 's1', reward: item('x') }));
  assert.throws(() => fresh({ status: 'destroyed', sessionId: 's1', destroyedAt: 'sideways' }));
  assert.throws(() =>
    fresh({ status: 'opened', sessionId: 's1', reward: item('x'), destroyedAt: 'impact' }),
  );
});

test('stored chests reject missing identities, appearance, session, contents and impossible values', () => {
  for (const value of [
    null,
    {},
    { ...fresh(), id: '' },
    { ...fresh(), status: 'opening' },
    { ...fresh(), status: 'opened', sessionId: 's1' },
    { ...fresh(), appearance: {} },
    { ...fresh(), contents: undefined },
    { ...fresh(), condition: 1.5 },
    { ...fresh(), traits: [{ id: 'moss', intensity: 2, seed: 1 }] },
    { ...fresh(), contents: [{ item: item('a'), weight: -1 }] },
    { ...opened('o', 's1'), rewardState: 'shattered' },
  ]) {
    assert.throws(() => copyCaseInstance(value));
  }
});

test('type inspection selects an owned available case, resumes unfinished cases and excludes consumed or other types', () => {
  const available = fresh(),
    opening = claimCase(fresh({ id: 'pending' }), 's1');
  const used = opened('used', 's2');
  const other = fresh({ caseId: 'other' });
  assert.equal(nextOwnedCase([other, used, opening, available], 'ender'), available);
  assert.equal(nextOwnedCase([other, used, opening], 'ender'), opening);
  assert.equal(nextOwnedCase([other, used], 'ender'), undefined);
});
