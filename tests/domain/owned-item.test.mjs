import assert from 'node:assert/strict';
import test from 'node:test';
import { canAfford, copyBalances, copyOwnedItem } from '../../src/domain/owned-item.ts';

const item = { id: 'pick', title: 'Кирка', image: '/pick.svg', rarity: 'rare', displayWeight: 0 };
const offers = {
  repair: { resource: 'deep-ore', value: 16 },
  salvage: { resource: 'deep-ore', value: 8 },
  sell: { resource: 'currency', value: 20 },
  mergeRepair: 70,
};
const owned = (id, state, extra = {}) =>
  copyOwnedItem({ id, item, state, origin: 'chest', offers, ...extra });

test('the merge twin is the one the server named, never the item itself', () => {
  assert.equal(
    owned('a', 'heavy', { offers: { ...offers, mergeWith: 'b' } }).offers.mergeWith,
    'b',
  );
  assert.equal(owned('a', 'heavy').offers.mergeWith, undefined, 'no twin named: nothing to merge');
  assert.throws(() => owned('a', 'heavy', { offers: { ...offers, mergeWith: 'a' } }));
  assert.equal(
    copyOwnedItem({ id: 'r', item, state: 'heavy', origin: 'x' }).offers,
    undefined,
    'a retired item has no offers',
  );
});

test('owned items and balances are validated and frozen', () => {
  assert.throws(() => copyOwnedItem({ id: 'a', item, state: 'melted', origin: 'x' }));
  assert.throws(() =>
    owned('a', 'heavy', { offers: { ...offers, sell: { resource: 'currency', value: 1.5 } } }),
  );
  assert.throws(() => owned('a', 'heavy', { offers: { ...offers, mergeRepair: 120 } }));
  assert.ok(Object.isFrozen(owned('a', 'heavy').offers.repair));
  const balances = copyBalances({ 'deep-ore': 16 });
  assert.ok(canAfford(balances, offers.repair));
  assert.ok(!canAfford(balances, { resource: 'deep-ore', value: 17 }));
  assert.ok(
    !canAfford(balances, { resource: 'end-shards', value: 1 }),
    'a resource never held is zero',
  );
  assert.throws(() => copyBalances({ currency: -1 }));
});
