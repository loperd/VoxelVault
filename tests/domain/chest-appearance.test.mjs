import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createChestAppearance,
  copyChestAppearance,
  changeChestAppearance,
  chestAppearanceKey,
  partConditions,
  resolveModifications,
  withBreakageDamage,
} from '../../src/domain/chest-appearance.ts';
import { ENDER_CASE } from '../../src/config/cases.ts';

const profile = ENDER_CASE.model.modifications;

test('instance appearance is immutable and each visual change invalidates its render key', () => {
  const original = createChestAppearance(18);
  const changed = changeChestAppearance(original, {
    palette: { panel: '#8855AA' },
    modifications: [{ id: 'lid-cracks', intensity: 0.6 }],
  });
  assert.deepEqual(original.modifications, []);
  assert.deepEqual(
    changed.modifications.map((item) => [item.id, item.intensity]),
    [['lid-cracks', 0.6]],
  );
  assert.equal(changed.palette.panel, '#8855aa');
  assert.equal(changed.revision, 1);
  assert.ok(Object.isFrozen(changed.palette));
  assert.ok(Object.isFrozen(changed.modifications));
  assert.ok(Object.isFrozen(changed.modifications[0]));
  assert.notEqual(chestAppearanceKey('v3', changed), chestAppearanceKey('v3', original));
  assert.notEqual(chestAppearanceKey('v4', original), chestAppearanceKey('v3', original));
  assert.equal(
    chestAppearanceKey('v3', original),
    chestAppearanceKey('v3', copyChestAppearance(original)),
  );
});

test('modifications upsert by id, keep their seed and are removed at zero intensity', () => {
  const first = changeChestAppearance(createChestAppearance(5), {
    modifications: [{ id: 'moss', intensity: 0.2 }],
  });
  const raised = changeChestAppearance(first, { modifications: [{ id: 'moss', intensity: 0.8 }] });
  assert.equal(raised.modifications[0].seed, first.modifications[0].seed);
  assert.notEqual(
    changeChestAppearance(createChestAppearance(6), {
      modifications: [{ id: 'moss', intensity: 0.2 }],
    }).modifications[0].seed,
    first.modifications[0].seed,
  );
  assert.deepEqual(
    changeChestAppearance(raised, { modifications: [{ id: 'moss', intensity: 0 }] }).modifications,
    [],
  );
});

test('version 1 saves migrate damage to the legacy crack entries', () => {
  const legacy = {
    schemaVersion: 1,
    revision: 3,
    seed: 9,
    palette: createChestAppearance().palette,
    damage: { body: 0.4, lid: 0 },
  };
  const migrated = copyChestAppearance(legacy);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.revision, 3);
  assert.deepEqual(migrated.modifications, [{ id: 'body-cracks', intensity: 0.4, seed: 9 }]);
  assert.deepEqual(copyChestAppearance(migrated), migrated);
});

test('invalid persisted appearance is rejected before reaching the renderer', () => {
  const appearance = createChestAppearance();
  const v1 = {
    schemaVersion: 1,
    revision: 0,
    seed: 1,
    palette: appearance.palette,
    damage: { body: 0, lid: 0 },
  };
  for (const value of [
    null,
    { ...appearance, schemaVersion: 99 },
    { ...appearance, seed: -1 },
    { ...appearance, revision: 0.2 },
    { ...appearance, palette: { ...appearance.palette, shell: 'red' } },
    { ...appearance, modifications: [{ id: 'moss', intensity: 2, seed: 1 }] },
    { ...appearance, modifications: [{ id: 'moss', intensity: 0, seed: 1 }] },
    {
      ...appearance,
      modifications: [
        { id: 'moss', intensity: 0.5, seed: 1 },
        { id: 'moss', intensity: 0.2, seed: 2 },
      ],
    },
    { ...appearance, modifications: [{ id: 'bad id!', intensity: 0.5, seed: 1 }] },
    { ...appearance, modifications: undefined },
    { ...v1, damage: { body: Infinity, lid: 0 } },
    { ...v1, damage: { body: 0, lid: 2 } },
  ]) {
    assert.throws(
      () => copyChestAppearance(value),
      (error) => error.code === 'INVALID_APPEARANCE',
    );
  }
});

test('entries unknown to the model are kept but not drawn; conditions follow the profile parts', () => {
  const appearance = changeChestAppearance(createChestAppearance(), {
    modifications: [
      { id: 'body-cracks', intensity: 0.3 },
      { id: 'latch-rust', intensity: 0.8 },
      { id: 'future-thing', intensity: 1 },
      { id: 'moss', intensity: 1 },
    ],
  });
  assert.deepEqual(
    resolveModifications(appearance, profile).map((item) => item.definition.id),
    ['body-cracks', 'latch-rust', 'moss'],
  );
  assert.deepEqual(
    partConditions(appearance, profile).map((item) => [item.part.id, item.value]),
    [
      ['body', 0.3],
      ['lid', 0],
      ['latch', 0.8],
    ],
  );
});

test('only an actual break adds damage: broken parts crack up to their severity, never lower', () => {
  const appearance = changeChestAppearance(createChestAppearance(), {
    modifications: [{ id: 'lid-cracks', intensity: 1 }],
  });
  assert.equal(
    withBreakageDamage(appearance, profile, []),
    appearance,
    'an intact landing changes nothing',
  );
  const damaged = withBreakageDamage(appearance, profile, [
    { part: 'body', severity: 0.6 },
    { part: 'lid', severity: 0.3 },
  ]);
  assert.deepEqual(
    damaged.modifications.map((item) => [item.id, item.intensity]),
    [
      ['lid-cracks', 1],
      ['body-cracks', 0.6],
    ],
  );
  assert.equal(withBreakageDamage(damaged, profile, [{ part: 'body', severity: 0.5 }]), damaged);
});
