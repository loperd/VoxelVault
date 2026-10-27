import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { normalizeChestBounds } from '../../src/adapters/outbound/chest/chest-bounds.ts';
import {
  assertChestDefinition,
  SPAWN_POSE,
} from '../../src/adapters/outbound/chest/physics-config.ts';

test('body and lid offsets are normalized together around the same physical origin', () => {
  const normalized = normalizeChestBounds(
    [
      { min: { x: -2, y: 0, z: -1 }, max: { x: 2, y: 2, z: 1 } },
      { min: { x: -2, y: 2, z: -1 }, max: { x: 2, y: 3, z: 1 } },
    ],
    2,
  );
  assert.equal(normalized.scale, 0.5);
  assert.deepEqual(normalized.center, { x: 0, y: 1.5, z: 0 });
  assert.deepEqual(normalized.colliders[0], {
    center: { x: 0, y: -0.25, z: 0 },
    halfExtents: { x: 1, y: 0.5, z: 0.5 },
  });
  assert.deepEqual(normalized.colliders[1], {
    center: { x: 0, y: 0.5, z: 0 },
    halfExtents: { x: 1, y: 0.25, z: 0.5 },
  });
  assert.doesNotThrow(() => assertChestDefinition(normalized.colliders, SPAWN_POSE));
  assert.ok(Object.isFrozen(normalized.colliders));
});

test('invalid geometry and non-normalized physics poses are rejected', () => {
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  assert.throws(() => normalizeChestBounds([]));
  assert.throws(() => normalizeChestBounds([box], 0));
  assert.throws(() => normalizeChestBounds([{ ...box, max: { x: NaN, y: 1, z: 1 } }]));
  assert.throws(() => normalizeChestBounds([{ ...box, max: { x: 0, y: 1, z: 1 } }]));
  assert.throws(() => assertChestDefinition([], SPAWN_POSE));
  const colliders = normalizeChestBounds([box]).colliders;
  assert.throws(() =>
    assertChestDefinition(colliders, { ...SPAWN_POSE, rotation: { x: 0, y: 0, z: 0, w: 2 } }),
  );
});

test('the restored GLB contains the exact named meshes, clips and Draco compression', async () => {
  const bytes = await readFile(new URL('../../public/models/treasure-game.glb', import.meta.url));
  assert.equal(bytes.readUInt32LE(0), 0x46546c67);
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
  for (const name of ['Chest_bottom', 'Chest_top', 'Key'])
    assert.ok(json.nodes.some((node) => node.name === name));
  for (const name of ['Chest_topAction', 'Key.001Action.001'])
    assert.ok(json.animations.some((clip) => clip.name === name));
  assert.ok(json.extensionsUsed.includes('KHR_draco_mesh_compression'));
  assert.equal(bytes.length, 214780);
});

test('active Ender model exposes the configured body, lid and opening clip', async () => {
  const { CASES } = await import('../../src/config/cases.ts');
  const model = CASES.find((value) => value.id === 'ender').model;
  const bytes = await readFile(new URL(`../../public/${model.path}`, import.meta.url));
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const current = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
  for (const name of [model.body, model.lid])
    assert.ok(current.nodes.some((node) => node.name === name));
  for (const name of model.openingClips)
    assert.ok(current.animations.some((clip) => clip.name === name));
  assert.ok(
    current.images.every((image) => image.bufferView !== undefined && image.uri === undefined),
  );
});
