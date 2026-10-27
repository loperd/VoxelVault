import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { ChestModificationLayers } from '../../src/adapters/outbound/chest/chest-modification-layers.ts';
import {
  fracturePattern,
  glowPattern,
  growthPattern,
  PATTERN_SIZE,
  wearPattern,
} from '../../src/adapters/outbound/chest/chest-surface-patterns.ts';
import {
  changeChestAppearance,
  createChestAppearance,
  resolveModifications,
} from '../../src/domain/chest-appearance.ts';
import { ENDER_CASE } from '../../src/config/cases.ts';

const profile = ENDER_CASE.model.modifications;
const style = (id) => profile.catalog.find((entry) => entry.id === id).style;

function chest() {
  const root = new Group(),
    geometry = new BoxGeometry(),
    material = new MeshStandardMaterial();
  const parts = Object.fromEntries(
    profile.parts.map((part) => {
      const mesh = new Mesh(geometry, material);
      mesh.name = part.nodes[0];
      root.add(mesh);
      return [part.id, mesh];
    }),
  );
  return {
    root,
    parts,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

test('patterns are deterministic per seed and respect the mask contract', () => {
  const patterns = [
    fracturePattern(style('body-cracks'), 4),
    wearPattern(style('latch-rust'), 4),
    ...['runes', 'veins', 'sparks'].map((pattern) =>
      glowPattern({ ...style('void-runes'), pattern }, 4),
    ),
    growthPattern(style('moss'), 4),
  ];
  for (const pixels of patterns) {
    assert.equal(pixels.length, PATTERN_SIZE * PATTERN_SIZE * 4);
    let covered = 0;
    for (let index = 0; index < pixels.length; index += 4)
      if (pixels[index + 3]) {
        covered++;
        assert.ok(pixels[index] >= 1);
      }
    assert.ok(covered > 0);
  }
  assert.deepEqual(wearPattern(style('latch-rust'), 4), wearPattern(style('latch-rust'), 4));
  assert.notDeepEqual(wearPattern(style('latch-rust'), 4), wearPattern(style('latch-rust'), 5));
});

test('each modification lands only on the parts its catalogue entry names, and disposal restores the model', () => {
  const { root, parts, dispose } = chest();
  const appearance = changeChestAppearance(createChestAppearance(3), {
    modifications: [
      { id: 'latch-rust', intensity: 0.8 },
      { id: 'void-runes', intensity: 0.6 },
      { id: 'end-crystals', intensity: 1 },
      { id: 'body-cracks', intensity: 0.5 },
    ],
  });
  const layers = new ChestModificationLayers(
    root,
    profile,
    resolveModifications(appearance, profile),
    0x35905f,
  );
  const overlays = (mesh) => mesh.children.filter((child) => child.userData.chestOverlay);
  assert.equal(overlays(parts.latch).length, 1);
  assert.equal(overlays(parts.body).length, 1, 'runes only; cracks belong to the fracture effects');
  const blocks = overlays(parts.lid).length - 1,
    clusters = style('end-crystals').count;
  assert.ok(
    blocks >= clusters * 2 && blocks <= clusters * 4,
    'each cluster is a small druse of 2–4 voxel blocks',
  );
  assert.ok(
    overlays(parts.lid).every(
      (child) => child.geometry === parts.lid.geometry || child.position.y > 0.5,
    ),
    'crystals sit on the top face',
  );
  layers.update(0.25);
  layers.dispose();
  for (const mesh of Object.values(parts)) assert.equal(mesh.children.length, 0);
  dispose();
});

test('intensity scales crystal count; pristine instances add nothing', () => {
  const { root, parts, dispose } = chest();
  const few = new ChestModificationLayers(
    root,
    profile,
    resolveModifications(
      changeChestAppearance(createChestAppearance(), {
        modifications: [{ id: 'end-crystals', intensity: 0.3 }],
      }),
      profile,
    ),
    0,
  );
  const clusters = Math.max(1, Math.round(style('end-crystals').count * 0.3));
  assert.ok(parts.lid.children.length >= clusters * 2 && parts.lid.children.length <= clusters * 4);
  few.dispose();
  new ChestModificationLayers(
    root,
    profile,
    resolveModifications(createChestAppearance(), profile),
    0,
  ).dispose();
  assert.equal(
    root.children.every((mesh) => mesh.children.length === 0),
    true,
  );
  dispose();
});

test('vines, cobwebs and snow add sprite geometry to their parts and leave nothing behind', () => {
  const { root, parts, dispose } = chest();
  const appearance = changeChestAppearance(createChestAppearance(11), {
    modifications: [
      { id: 'vines', intensity: 1 },
      { id: 'snow', intensity: 1 },
      { id: 'cobweb', intensity: 1 },
      { id: 'glow-lichen', intensity: 0.8 },
    ],
  });
  const layers = new ChestModificationLayers(
    root,
    profile,
    resolveModifications(appearance, profile),
    0,
  );
  const added = Object.values(parts).flatMap((mesh) => mesh.children);
  assert.ok(added.every((child) => child.userData.chestOverlay));
  assert.ok(
    parts.lid.children.filter((child) => child.geometry.type === 'PlaneGeometry').length >=
      style('vines').count,
  );
  assert.ok(
    parts.lid.children.filter(
      (child) => child.geometry.type === 'BoxGeometry' && child.position.y > 0.5,
    ).length >= 4,
    'snow columns lie on the lid top',
  );
  assert.ok(
    parts.body.children.some((child) => child.material.type === 'ShaderMaterial'),
    'lichen is a surface overlay',
  );
  layers.dispose();
  for (const mesh of Object.values(parts)) assert.equal(mesh.children.length, 0);
  dispose();
});
