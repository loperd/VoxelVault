import test from 'node:test';
import assert from 'node:assert/strict';
import { MINER_VAULT } from '../../src/adapters/outbound/worlds/miner/index.ts';
import {
  OVERWORLD_BLOCKS,
  SUN,
  SUN_DISC,
} from '../../src/adapters/outbound/worlds/overworld-blocks.ts';
import { END_3D } from '../../src/adapters/outbound/worlds/end-3d.ts';
import { DRAGON_3D } from '../../src/adapters/outbound/worlds/dragon-3d.ts';

// Canvas is used only for textures; geometry and light need no WebGL.
function withCanvas(run) {
  const original = globalThis.document;
  const context = new Proxy({}, { get: () => () => {} });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  try {
    return run();
  } finally {
    globalThis.document = original;
  }
}

const bearing = ([x, , z]) => Math.atan2(z, x);
const angle = (a, b) =>
  Math.acos(a.reduce((s, v, i) => s + v * b[i], 0) / Math.hypot(...a) / Math.hypot(...b));

test('the 3D worlds light their chest from the camera side', () => {
  const stages = withCanvas(() =>
    [OVERWORLD_BLOCKS, MINER_VAULT, END_3D, DRAGON_3D].map((world) => [world.id, world.build(11)]),
  );
  for (const [id, stage] of stages) {
    const from = stage.light?.from;
    assert(from, `${id}: light.from`);
    const toCamera = stage.camera.position.map((v, i) => v - stage.anchor[i]);
    assert(
      from[0] * toCamera[0] + from[1] * toCamera[1] + from[2] * toCamera[2] > 0,
      `${id}: the key is behind the chest`,
    );
  }
});

test('overworld: from the camera, the sky halo sits on the square sun and the baked sun shares its bearing', () => {
  const stage = withCanvas(() => OVERWORLD_BLOCKS.build(11));
  let disc;
  stage.root.traverse((o) => {
    if (o.isMesh && o.position.length() > 400) disc = o;
  });
  assert.deepEqual(disc.position.toArray(), [...SUN_DISC]);
  // The sky dome follows the camera, so its halo is at sun.direction from the eye; the square is at a point.
  const toDisc = SUN_DISC.map((v, i) => v - stage.camera.position[i]);
  const halfDisc = Math.atan(30 / Math.hypot(...toDisc));
  assert(angle(stage.sun.direction, toDisc) < halfDisc, 'the halo glows off the square');
  // Only the bearing: the baked sun stands higher (28° against the square's 6°) so block shadows stay short.
  assert(
    Math.abs(bearing(SUN.direction) - bearing(toDisc)) < 0.03,
    'the baked shadows fall away from the square',
  );
});
