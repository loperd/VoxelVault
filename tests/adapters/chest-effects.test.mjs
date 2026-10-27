import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Scene } from 'three';
import { ChestFractureEffects } from '../../src/adapters/outbound/chest/chest-fracture-effects.ts';
import { ChestImpactEffects } from '../../src/adapters/outbound/chest/chest-impact-effects.ts';
import { copyModificationProfile } from '../../src/domain/chest-modifications.ts';

const crack = {
  branches: 20,
  minLength: 4,
  maxLength: 12,
  drift: 0.5,
  scarColor: '#0a1715',
  scale: 1,
};
const profile = (
  catalog = [
    { id: 'body-cracks', label: 'Body', kind: 'fracture', parts: ['body'], style: crack },
    { id: 'lid-cracks', label: 'Lid', kind: 'fracture', parts: ['lid'], style: crack },
  ],
) =>
  copyModificationProfile({
    schemaVersion: 1,
    revision: 't',
    colorZones: [],
    catalog,
    parts: [
      { id: 'body', label: 'Body', nodes: ['Body.Geometry'] },
      { id: 'lid', label: 'Lid', nodes: ['Lid.Geometry'] },
    ],
  });

test('fractures replay and reset without changing or disposing the source geometry', () => {
  const chest = new Group(),
    geometry = new BoxGeometry(),
    material = new MeshStandardMaterial();
  const body = new Mesh(geometry, material);
  body.name = 'Body.Geometry';
  chest.add(body);
  let sourceDisposals = 0;
  geometry.addEventListener('dispose', () => sourceDisposals++);
  const effects = new ChestFractureEffects(chest, 0x86ead0, undefined, profile());
  const scar = body.children[0],
    overlay = body.children[1];
  assert.equal(overlay.geometry, geometry);
  for (let cycle = 0; cycle < 2; cycle++) {
    effects.start(false);
    effects.update(0.1, true);
    effects.impact();
    effects.update(0.2, false);
    assert.equal(overlay.visible, true);
    assert.ok(overlay.material.uniforms.strength.value > 0);
    effects.update(1.1, false);
    assert.equal(overlay.visible, false);
    assert.equal(scar.visible, true);
    effects.reset();
    assert.equal(scar.visible, false);
  }
  effects.start(true);
  effects.impact();
  effects.update(0.1, false);
  assert.equal(overlay.visible, false);
  assert.equal(scar.visible, true);
  effects.dispose();
  assert.equal(body.children.length, 0);
  assert.equal(chest.children.length, 1);
  assert.equal(sourceDisposals, 0);
  geometry.dispose();
  material.dispose();
});

test('falling trail hands off to impact, then releases all scene objects', () => {
  const scene = new Scene(),
    effects = new ChestImpactEffects(scene);
  const root = scene.children[0];
  effects.approach(1, 3, 2, false);
  assert.equal(root.visible, true);
  effects.trigger(1, 2, false);
  effects.update(0.2);
  assert.equal(root.visible, true);
  effects.update(1);
  assert.equal(root.visible, false);
  effects.approach(0, 3, 0, true);
  assert.equal(root.visible, false);
  effects.dispose();
  assert.equal(scene.children.length, 0);
});

test('opening burst replays and disposes beams, halo and particles without removing the chest', async () => {
  const { ChestOpeningEffects } =
    await import('../../src/adapters/outbound/chest/chest-opening-effects.ts');
  const chest = new Group(),
    geometry = new BoxGeometry(),
    material = new MeshStandardMaterial();
  const body = new Mesh(geometry, material);
  chest.add(body);
  const effects = new ChestOpeningEffects(chest);
  const root = chest.children[1];
  for (let cycle = 0; cycle < 2; cycle++) {
    effects.start();
    effects.update(0.75, false);
    assert.equal(root.visible, true);
    const beamGroup = root.children.find((child) => child instanceof Group);
    assert.equal(beamGroup.visible, true);
    assert.equal(beamGroup.children.length, 5);
    effects.stop();
    assert.equal(root.visible, false);
  }
  effects.start();
  effects.update(1, true);
  assert.equal(root.children.find((child) => child instanceof Group).visible, false);
  effects.dispose();
  assert.deepEqual(chest.children, [body]);
  geometry.dispose();
  material.dispose();
});

test('stored body and lid scars retain independent levels through reset and replay', async () => {
  const { createChestAppearance, changeChestAppearance } =
    await import('../../src/domain/chest-appearance.ts');
  const appearance = changeChestAppearance(createChestAppearance(17), {
    modifications: [{ id: 'body-cracks', intensity: 0.8 }],
  });
  const chest = new Group(),
    geometry = new BoxGeometry(),
    material = new MeshStandardMaterial();
  const body = new Mesh(geometry, material);
  body.name = 'Body.Geometry';
  const lid = new Mesh(geometry, material);
  lid.name = 'Lid.Geometry';
  chest.add(body, lid);
  const effects = new ChestFractureEffects(chest, 0x86ead0, appearance, profile());
  assert.equal(body.children[0].visible, true);
  assert.equal(lid.children[0].visible, false);
  effects.start(false);
  effects.charge(0.5);
  assert.equal(body.children[0].visible, true);
  effects.impact();
  effects.update(0.5, false);
  assert.equal(lid.children[0].visible, true);
  effects.reset();
  assert.equal(body.children[0].visible, true);
  assert.equal(lid.children[0].visible, false);
  effects.dispose();
  geometry.dispose();
  material.dispose();
});

test('a model without fracture entries never cracks, and entries only touch their own parts', () => {
  const chest = new Group(),
    geometry = new BoxGeometry(),
    material = new MeshStandardMaterial();
  const body = new Mesh(geometry, material);
  body.name = 'Body.Geometry';
  const lid = new Mesh(geometry, material);
  lid.name = 'Lid.Geometry';
  chest.add(body, lid);
  const none = new ChestFractureEffects(chest, 0x86ead0, undefined, profile([]));
  assert.equal(none.available, false);
  assert.equal(body.children.length, 0);
  none.start(false);
  none.impact();
  none.update(0.1, false);
  assert.equal(body.children.length, 0);
  none.dispose();
  const lidOnly = new ChestFractureEffects(
    chest,
    0x86ead0,
    undefined,
    profile([{ id: 'lid-cracks', label: 'Lid', kind: 'fracture', parts: ['lid'], style: crack }]),
  );
  assert.equal(body.children.length, 0);
  assert.equal(lid.children.length, 2);
  lidOnly.dispose();
  assert.equal(lid.children.length, 0);
  geometry.dispose();
  material.dispose();
});
