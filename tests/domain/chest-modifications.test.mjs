import assert from 'node:assert/strict';
import test from 'node:test';
import { copyModificationProfile } from '../../src/domain/chest-modifications.ts';
import { ENDER_REFERENCE_MODIFICATIONS } from '../../src/config/ender-modifications.ts';

const base = ENDER_REFERENCE_MODIFICATIONS;
const rejects = (value) =>
  assert.throws(
    () => copyModificationProfile(value),
    (error) => error.code === 'INVALID_MODIFICATION_PROFILE',
  );

test('server profile is validated, normalised and frozen', () => {
  const profile = copyModificationProfile(base);
  assert.deepEqual(
    profile.parts.map((part) => part.id),
    ['body', 'lid', 'latch'],
  );
  assert.equal(profile.catalog.length, base.catalog.length);
  assert.ok(
    Object.isFrozen(profile) &&
      Object.isFrozen(profile.catalog[0].style) &&
      Object.isFrozen(profile.parts[0].nodes),
  );
  assert.equal(profile.colorZones[0].materials.length, 0);
  assert.equal(profile.catalog.find((entry) => entry.id === 'void-runes').style.color, '#3f8f74');
  const accentGlow = copyModificationProfile({
    ...base,
    catalog: [
      {
        id: 'g',
        label: 'G',
        kind: 'glow',
        parts: ['body'],
        style: { pattern: 'sparks', density: 0.5, scale: 1 },
      },
    ],
  });
  assert.equal(
    accentGlow.catalog[0].style.color,
    undefined,
    'a glow without colour follows the instance accent',
  );
});

test('unknown kinds from a newer server are skipped, broken known entries are refused', () => {
  const extended = copyModificationProfile({
    ...base,
    catalog: [...base.catalog, { id: 'sticker', kind: 'decal', parts: ['body'], style: {} }],
  });
  assert.equal(extended.catalog.length, base.catalog.length);
  const entry = base.catalog[0];
  rejects({ ...base, schemaVersion: 2 });
  rejects({ ...base, parts: [...base.parts, base.parts[0]] });
  rejects({ ...base, catalog: [...base.catalog, entry] });
  rejects({ ...base, catalog: [{ ...entry, parts: ['wheel'] }] });
  rejects({ ...base, catalog: [{ ...entry, style: { ...entry.style, branches: 0 } }] });
  rejects({
    ...base,
    catalog: [{ ...entry, style: { ...entry.style, maxLength: entry.style.minLength - 1 } }],
  });
  rejects({
    ...base,
    catalog: [
      {
        id: 'g',
        label: 'G',
        kind: 'growth',
        parts: ['body'],
        style: { type: 'lava', color: '#ffffff', scale: 1 },
      },
    ],
  });
  rejects({ ...base, colorZones: [{ role: 'shell', mode: 'tint' }] });
  rejects({ ...base, colorZones: [{ role: 'gold', mode: 'tint', nodes: ['Chest_bottom'] }] });
  rejects({ ...base, parts: [{ id: 'body', label: 'Корпус', nodes: [] }] });
});
