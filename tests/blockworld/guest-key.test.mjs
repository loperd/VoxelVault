import assert from 'node:assert/strict';
import test from 'node:test';
import { Group, Vector3 } from 'three';
import { BlockView, guestKey } from '../../packages/blockworld/src/index.ts';
import { fakePage } from './pack-fixture.mjs';

const close = (actual, expected, message) =>
  actual.forEach((v, i) =>
    assert.ok(Math.abs(v - expected[i]) < 1e-9, `${message}: ${actual} vs ${expected}`),
  );

test("guestKey: the world's key, in the frame of a guest the world turned, at the distance asked", () => {
  const from = [2, 3, -1],
    length = Math.hypot(...from);
  for (const turn of [0, Math.PI / 2, -2.3, Math.PI]) {
    const key = guestKey({ turn, light: { sky: '#fff', ground: '#000', key: '#fff', from } }, 7);
    assert.ok(
      Math.abs(Math.hypot(...key) - 7) < 1e-9,
      'at the distance, whatever the length of `from`',
    );
    // Placed in a guest turned as the view turns it (rotation.y = turn), it points along `from` in the world.
    const guest = new Group();
    guest.rotation.y = turn;
    guest.updateMatrixWorld();
    close(
      guest
        .localToWorld(new Vector3(...key))
        .divideScalar(7)
        .toArray(),
      from.map((v) => v / length),
      `turn ${turn}`,
    );
  }
  assert.equal(guestKey({ turn: 1 }, 7), undefined, 'no light: the guest keeps its own key');
  assert.equal(
    guestKey({ turn: 1, light: { sky: '#fff', ground: '#000', key: '#fff' } }, 7),
    undefined,
    'a light without `from`: the same',
  );
});

test("home: where the stage puts the camera, the stage's own object", () => {
  const page = fakePage();
  try {
    const camera = { position: [1, 2, 5], target: [0, 1, 0], fov: 40 };
    const view = new BlockView(page.element(), {
      id: 'home-camera',
      cache: false,
      build: () => ({
        root: new Group(),
        living: [],
        sky: { top: '#000000', horizon: '#000000', bottom: '#000000' },
        fog: { color: '#000000', near: 1, far: 2 },
        camera,
        dispose() {},
      }),
    });
    assert.equal(view.home, camera);
    assert.equal(view.home, view.stage.camera);
    view.dispose();
  } finally {
    page.restore();
  }
});
