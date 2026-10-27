import assert from 'node:assert/strict';
import test from 'node:test';
import { Group } from 'three';
import { BlockView } from '../../packages/blockworld/src/index.ts';
import { fakePage } from './pack-fixture.mjs';

const plain = () => ({
  id: 'view-lifecycle',
  cache: false,
  build: () => ({
    root: new Group(),
    living: [],
    sky: { top: '#000000', horizon: '#000000', bottom: '#000000' },
    fog: { color: '#000000', near: 1, far: 2 },
    camera: { position: [0, 2, 9], target: [0, 1, 0], drift: 1 },
    dispose() {},
  }),
});

test('a view behind a game screen spends no frames and draws nothing, but a snapshot still draws; aim stands the camera still', () => {
  const page = fakePage(),
    frames = { asked: 0, cancelled: 0 };
  Object.assign(page.document.defaultView, {
    requestAnimationFrame: () => ++frames.asked,
    cancelAnimationFrame: () => {
      frames.cancelled++;
    },
  });
  try {
    const view = new BlockView(page.element(), plain()),
      renders = [];
    const render = view.renderer.render;
    view.renderer.render = (scene, camera) => {
      renders.push(scene);
      render.call(view.renderer, scene, camera);
    };
    assert.ok(frames.asked > 0, 'a live view asks for frames');
    view.setActive(false);
    assert.equal(frames.cancelled, 1, 'and stops asking when hidden');
    renders.length = 0;
    view.renderAt(3);
    assert.equal(renders.length, 0, 'an inactive view draws nothing');
    view.snapshot();
    assert.ok(renders.length > 0, 'a snapshot draws all the same');
    const asked = frames.asked;
    view.setActive(true);
    assert.equal(frames.asked, asked + 1, 'active again: frames again');
    view.aim([4, 5, 6], [0, 1, 0]);
    view.renderAt(30);
    assert.deepEqual(view.camera.position.toArray(), [4, 5, 6], 'aimed: no drift');
    assert.deepEqual(view.home.position, [0, 2, 9], "the stage's own place unchanged");
    view.dispose();
    assert.deepEqual([view.canvas.width, view.canvas.height], [0, 0], 'the canvas freed');
  } finally {
    page.restore();
  }
});
