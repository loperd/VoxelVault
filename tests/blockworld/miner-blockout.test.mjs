import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, PerspectiveCamera, Raycaster, Vector3 } from 'three';
import { MINER_BLOCKOUT } from '../../src/adapters/outbound/worlds/miner/blockout.ts';
import { MINE_COMPOSITION } from '../../src/adapters/outbound/worlds/miner/composition.ts';

test('blockout camera places the supported viaduct on the reference composition axis', () => {
  const stage = MINER_BLOCKOUT.build(11);
  const camera = new PerspectiveCamera(stage.camera.fov, 1536 / 960, 0.1, 1200);
  camera.position.set(...stage.camera.position);
  camera.lookAt(new Vector3(...stage.camera.target));
  camera.updateMatrixWorld();
  const p = new Vector3(0, 0, -9.5).project(camera);
  assert(Math.abs(p.x) < 1e-6);
  assert((1 - p.y) / 2 > 0.55 && (1 - p.y) / 2 < 0.66);
  const bounds = new Box3().setFromObject(stage.root.getObjectByName('hero-fortress'));
  assert(bounds.max.z - bounds.min.z >= 12, 'fortress must have real depth');
  assert(bounds.max.y > 25);
});

test('the portal opens into a continuous tunnel and the central foreground stays clear', () => {
  const stage = MINER_BLOCKOUT.build(11);
  stage.root.updateMatrixWorld(true);
  const portal = stage.root.getObjectByName('deep-corbelled-portal-and-buttresses');
  const ray = new Raycaster(new Vector3(0, 4, -10), new Vector3(0, 0, -1), 0, 130);
  assert.equal(ray.intersectObject(portal, true).length, 0, 'portal has an open central passage');
  const tunnel = new Box3().setFromObject(
    stage.root.getObjectByName('continuous-deep-mine-tunnel'),
  );
  assert(tunnel.min.z <= MINE_COMPOSITION.tunnel.end);
  const foreground = stage.root.getObjectByName('foreground-framing-ledges');
  const sightline = new Raycaster(new Vector3(0, 2, 29), new Vector3(0, 0, -1), 0, 24);
  assert.equal(
    sightline.intersectObject(foreground, true).length,
    0,
    'no black central foreground cube',
  );
});
