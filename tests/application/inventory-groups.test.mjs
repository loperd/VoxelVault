import assert from 'node:assert/strict';
import test from 'node:test';
import { damageLevel, groupInventory } from '../../src/application/inventory-groups.ts';
import { createChestAppearance, changeChestAppearance } from '../../src/domain/chest-appearance.ts';
const make = (id, appearance = createChestAppearance()) => ({
  id,
  caseId: 'ender',
  status: 'available',
  appearance,
});

test('100 equal cases stack without losing unique identities or seeds', () => {
  const items = Array.from({ length: 100 }, (_, index) =>
    make(String(index), createChestAppearance(index)),
  );
  const groups = groupInventory(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].instances.length, 100);
  assert.equal(groups[0].representative, items[0]);
  assert.deepEqual(groups[0].instances, items);
});
test('type, class, every palette zone, each modification and lifecycle separate stacks', () => {
  const base = make('base');
  const variants = [
    { ...base, id: 'type', caseId: 'other' },
    { ...base, id: 'status', status: 'opened' },
    { ...base, id: 'class', rarity: 'epic' },
    ...['shell', 'panel', 'metal', 'accent'].map((zone) =>
      make(zone, changeChestAppearance(base.appearance, { palette: { [zone]: '#ff0000' } })),
    ),
    make(
      'body',
      changeChestAppearance(base.appearance, {
        modifications: [{ id: 'body-cracks', intensity: 0.3 }],
      }),
    ),
    make(
      'lid',
      changeChestAppearance(base.appearance, {
        modifications: [{ id: 'lid-cracks', intensity: 0.3 }],
      }),
    ),
  ];
  assert.equal(groupInventory([base, ...variants]).length, 10);
  const worn = [0.26, 0.49].map((damage, index) =>
    make(
      String(index),
      changeChestAppearance(base.appearance, {
        modifications: [{ id: 'body-cracks', intensity: damage }],
      }),
    ),
  );
  assert.equal(groupInventory(worn).length, 1);
  assert.equal(groupInventory([base, ...worn]).length, 2);
});
test('wear bands preserve pristine and every severity boundary', () => {
  assert.deepEqual(
    [0, 0.001, 0.25, 0.251, 0.5, 0.501, 0.75, 0.751, 1].map((value) => damageLevel(value).rank),
    [0, 1, 1, 2, 2, 3, 3, 4, 4],
  );
});
