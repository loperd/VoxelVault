import assert from 'node:assert/strict';
import test from 'node:test';
import { BlockRegistry } from '../../packages/blockworld/src/blocks.ts';
import { BlockWorld } from '../../packages/blockworld/src/world.ts';
import { WorldPhysics } from '../../packages/blockworld/src/physics.ts';
import { WorldBodyPhysics } from '../../src/adapters/outbound/chest/world-body-physics.ts';

const blocks = new BlockRegistry([
  { name: 'stone', textures: { all: 'stone' } },
  { name: 'poppy', model: 'cross', textures: { all: 'poppy' } },
]);
/** Flat stone 3 blocks deep with its top at y 3, a step up at x ≥ 4, and a flower (not solid). */
function terrain() {
  const world = new BlockWorld(16, 8, 16, [-8, 0, -8]);
  world.fill(0, 0, 0, 15, 2, 15, blocks.id('stone'));
  world.fill(12, 3, 0, 15, 3, 15, blocks.id('stone'));
  world.set(8, 3, 8, blocks.id('poppy'));
  return world;
}
const cube = { boxes: [{ center: [0, 0, 0], half: [0.5, 0.5, 0.5] }] };
const at = (y) => ({ position: [0, y, 0], rotation: [0, 0, 0, 1] });

test("a body falls onto the world's own blocks and rests on top of them (through a flower)", async () => {
  const physics = await WorldPhysics.create({
    blocks: { world: terrain(), registry: blocks, around: [0, 0], radius: 6 },
  });
  try {
    const body = physics.add({ ...cube, pose: at(7) });
    physics.settle();
    assert.equal(body.sleeping(), true);
    const y = body.pose().position[1];
    assert.ok(Math.abs(y - 3.5) < 0.05, `rests on the stone top at y 3: ${y.toFixed(3)}`);
  } finally {
    physics.dispose();
  }
});

test("the world's clock: syncing twice to the same moment steps nothing more", async () => {
  const physics = await WorldPhysics.create({ floor: 0 });
  try {
    const body = physics.add({ ...cube, pose: at(5) });
    physics.sync(0);
    physics.sync(50);
    const once = body.pose().position[1];
    physics.sync(50);
    physics.sync(50);
    assert.equal(
      body.pose().position[1],
      once,
      'a second caller in the same frame does not step again',
    );
    assert.ok(once < 5, 'but time did move it');
  } finally {
    physics.dispose();
  }
});

test('a blast throws a resting body up and away; one far off stays put', async () => {
  const physics = await WorldPhysics.create({ floor: 0 });
  try {
    const near = physics.add({ ...cube, pose: { position: [1, 0.5, 0], rotation: [0, 0, 0, 1] } });
    const far = physics.add({ ...cube, pose: { position: [20, 0.5, 0], rotation: [0, 0, 0, 1] } });
    physics.settle();
    physics.blast([0, 0.5, 0], 5, 4);
    for (let t = 0; t <= 300; t += 16) physics.sync(t);
    assert.ok(near.pose().position[0] > 1.5, 'thrown away from the blast');
    assert.ok(Math.abs(far.pose().position[0] - 20) < 0.01, 'out of reach');
  } finally {
    physics.dispose();
  }
});

test("the chest's body: its units and turn in, the world's blocks out, and back the same", async () => {
  const physics = await WorldPhysics.create({ floor: 10 });
  try {
    const world = { sync() {}, anchor: [4, 10, -2], turn: Math.PI / 2 };
    const chest = new WorldBodyPhysics(physics, world, 1.7);
    const pose = { position: { x: 1.7, y: 3.4, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    chest.resetChest(
      [{ center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 0.85, y: 0.85, z: 0.85 } }],
      pose,
    );
    const back = chest.readChestPose();
    for (const axis of ['x', 'y', 'z'])
      assert.ok(Math.abs(back.position[axis] - pose.position[axis]) < 1e-5, axis);
    chest.settle();
    assert.ok(
      Math.abs(chest.readChestPose().position.y - 0.85) < 0.05,
      'rests on the anchor block: its floor is y 0',
    );
  } finally {
    physics.dispose();
  }
});

test('a held body hangs in the air: no gravity, no blast moves it; let go, it falls and lands level', async () => {
  const physics = await WorldPhysics.create({ floor: 0 });
  try {
    const body = physics.add({
      boxes: [{ center: [0, 0, 0], half: [0.5, 0.5, 0.5] }],
      pose: at(3),
    });
    body.hold(true);
    physics.blast([1, 3, 0], 5, 4);
    for (let t = 0; t <= 1000; t += 16) physics.sync(t);
    assert.deepEqual(body.pose().position, [0, 3, 0], 'still where it hung');
    assert.equal(physics.awake(), false, 'nothing for the world to simulate');
    body.hold(false);
    physics.settle();
    const { position, rotation } = body.pose();
    assert.ok(
      Math.abs(position[1] - 0.5) < 0.05 && Math.hypot(position[0], position[2]) < 0.25,
      'down onto the floor, a bounce off its spot at most',
    );
    assert.ok(Math.abs(rotation[0]) < 0.01 && Math.abs(rotation[2]) < 0.01, 'level');
  } finally {
    physics.dispose();
  }
});

test('the chest carried into another world keeps hanging if it hung', async () => {
  const physics = await WorldPhysics.create({ floor: 0 });
  try {
    const chest = new WorldBodyPhysics(physics, { sync() {}, anchor: [0, 0, 0], turn: 0 }, 1.7);
    chest.resetChest(
      [{ center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 0.85, y: 0.85, z: 0.85 } }],
      { position: { x: 0, y: 3, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    );
    chest.setChestMoving(false);
    assert.equal(chest.carryOver().moving, false);
    chest.setChestMoving(true);
    assert.equal(chest.carryOver().moving, true);
  } finally {
    physics.dispose();
  }
});
