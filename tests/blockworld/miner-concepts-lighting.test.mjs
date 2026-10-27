import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockWorld } from '../../packages/blockworld/src/index.ts';
import { MINER_CONCEPTS } from '../../src/adapters/outbound/worlds/miner-concepts/index.ts';

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

/** The BlockWorlds a stage builds, caught as they are written to. */
function worldsOf(build) {
  const worlds = [],
    set = BlockWorld.prototype.set;
  BlockWorld.prototype.set = function (...args) {
    if (!worlds.includes(this)) worlds.push(this);
    return set.apply(this, args);
  };
  try {
    withCanvas(build);
  } finally {
    BlockWorld.prototype.set = set;
  }
  return worlds;
}

test('the gallery hall stays inside its world: no air on any outer face', () => {
  for (const seed of [1, 7, 11, 42]) {
    const [world] = worldsOf(() => MINER_CONCEPTS['concept-gallery'].build(seed));
    const { sx, sy, sz } = world;
    for (let z = 0; z < sz; z++)
      for (let y = 0; y < sy; y++)
        for (let x = 0; x < sx; x++) {
          if (x && y && z && x < sx - 1 && y < sy - 1 && z < sz - 1) continue;
          assert(world.get(x, y, z), `seed ${seed}: open to the void at ${x},${y},${z}`);
        }
  }
});

test('every miner concept lights its chest from the camera side', () => {
  const stages = withCanvas(() =>
    Object.values(MINER_CONCEPTS).map((world) => [world.id, world.build(11)]),
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
