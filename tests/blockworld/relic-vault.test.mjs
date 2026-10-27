import assert from 'node:assert/strict';
import test from 'node:test';
import { Box3 } from 'three';
import { RELIC_VAULT } from '../../src/adapters/outbound/worlds/relic-vault.ts';

test('containment chamber supports its guest and batches its geometry', () => {
  const stage = RELIC_VAULT.build(1);
  const plinth = new Box3().setFromObject(stage.root.getObjectByName('relic-plinth'));
  assert.ok(Math.abs(plinth.max.y - stage.anchor[1]) < 1e-6);
  assert.equal(stage.ground.boxes[0].center[1] + stage.ground.boxes[0].half[1], stage.anchor[1]);
  let draws = 0;
  stage.root.traverse((o) => {
    if (o.isMesh) draws++;
  });
  assert.ok(draws <= 4, 'scenery stays inexpensive');
  assert.ok(stage.light.keyStrength > 0 && stage.light.fillStrength > 0);
  assert.ok(stage.camera.target[1] > stage.anchor[1]);
});
