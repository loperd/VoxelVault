import assert from 'node:assert/strict';
import test from 'node:test';
import { Box3 } from 'three';
import { END_3D } from '../../src/adapters/outbound/worlds/end-3d.ts';

test('End scene builds with blockworld terrain in world coordinates and finite animated geometry', () => {
  // Only atlas painting needs a canvas; terrain generation and meshing run without WebGL.
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => ({ getContext: () => ({ fillRect() {}, clearRect() {} }) }),
  };
  let stage;
  try {
    stage = END_3D.build(11);
  } finally {
    globalThis.document = previous;
  }
  const terrain = stage.root.children.find((object) => object.isMesh);
  assert.ok(terrain, 'islands are actually meshed');
  const bounds = new Box3().setFromObject(terrain);
  assert.ok(bounds.min.x < -50 && bounds.max.x > 50, 'grid origin applied exactly once');
  assert.ok(bounds.min.z < -80 && bounds.max.z > 16, 'near and far islands retain world placement');
  assert.ok(terrain.material.map, 'terrain uses the existing shared block atlas');
  assert.ok(terrain.geometry.attributes.uv.count > 0);
  assert.ok(terrain.geometry.index.count > 0);
  // The chest lands on the island's flat top, which is the physics ground under it.
  const { world } = stage.ground.blocks,
    [ax, ay, az] = stage.anchor,
    [ox, oy, oz] = world.origin;
  assert.notEqual(
    world.get(Math.floor(ax - ox), ay - 1 - oy, Math.floor(az - oz)),
    0,
    'a block under the anchor',
  );
  assert.equal(
    world.get(Math.floor(ax - ox), ay - oy, Math.floor(az - oz)),
    0,
    'air at the anchor',
  );
  for (const time of [0, 1, 24]) {
    for (const actor of stage.living)
      actor.update(
        { time, wind: 0, rand: () => 0.5, host: undefined, gust() {}, flash() {}, blast() {} },
        1 / 60,
      );
    stage.root.traverse((object) => {
      for (const value of [...object.position, ...object.rotation.toArray().slice(0, 3)])
        assert.ok(Number.isFinite(value));
      if (object.geometry)
        for (const attribute of Object.values(object.geometry.attributes)) {
          for (const value of attribute.array) assert.ok(Number.isFinite(value));
        }
    });
  }
});
