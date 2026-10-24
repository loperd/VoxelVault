import assert from 'node:assert/strict';
import test from 'node:test';
import { TRAVELER_SHRINE } from '../../src/adapters/outbound/worlds/traveler-shrine.ts';
import { BLOCK_WORLDS } from '../../src/adapters/outbound/worlds/index.ts';
import { CASES } from '../../src/config/cases.ts';

// The block atlas is drawn on a canvas; the geometry under test needs no real one.
function withCanvas(run) {
  const original = globalThis.document, context = new Proxy({}, { get: () => () => {} });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  try { return run(); } finally { globalThis.document = original; }
}

test('the traveler\'s chest stands in the shrine, on top of the pedestal', () => withCanvas(() => {
  assert.equal(CASES.find(item => item.id === 'traveler').presentation.world, 'shrine');
  assert.equal(BLOCK_WORLDS.shrine, TRAVELER_SHRINE);
  const stage = TRAVELER_SHRINE.build(1);
  const { world, around } = stage.ground.blocks;
  const [ox, oy, oz] = world.origin, [ax, ay, az] = stage.anchor;
  assert.deepEqual(around, [ax, az]);
  // The cell under the anchor is a block of the pedestal, the one above it is air.
  const x = Math.floor(ax - ox), y = Math.round(ay - oy) - 1, z = Math.floor(az - oz);
  assert.ok(world.get(x, y, z), 'a block under the chest');
  assert.ok(!world.get(x, y + 1, z), 'air above it');
  assert.ok(stage.camera.target[1] > ay);
}));
