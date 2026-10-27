import assert from 'node:assert/strict';
import test from 'node:test';
import { DRAGON_3D } from '../../src/adapters/outbound/worlds/dragon-3d.ts';

test('Dragon scene: the chest lands in the portal, beams follow the dragon, and its sweep pulls the chest handles', () => {
  // Only atlas painting needs a canvas; terrain generation and meshing run without WebGL.
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => ({ getContext: () => ({ fillRect() {}, clearRect() {} }) }),
  };
  let stage;
  try {
    stage = DRAGON_3D.build(11);
  } finally {
    globalThis.document = previous;
  }
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
  const pulled = [];
  const host = {
    tremor: () => pulled.push('tremor'),
    light: () => pulled.push('light'),
    gust() {},
  };
  const context = (time) => ({
    time,
    wind: 0,
    rand: () => 0.5,
    host,
    gust() {},
    flash() {},
    blast() {},
  });
  // Long enough for the first sweep (it starts at 20 s and lasts 6 s).
  for (let time = 0; time < 30; time += 1 / 30)
    for (const actor of stage.living) actor.update(context(time), 1 / 30);
  assert.deepEqual(pulled, ['tremor', 'light'], 'one sweep, one strike');
  stage.root.traverse((object) => {
    for (const value of object.position) assert.ok(Number.isFinite(value));
    if (object.isLine)
      assert.ok(object.geometry.attributes.position.getY(1) > 0, 'beams reach the dragon');
  });
});
