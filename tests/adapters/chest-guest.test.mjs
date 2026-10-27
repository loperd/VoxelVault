import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { ThreeChestDropScene } from '../../src/adapters/outbound/chest/three-chest-drop-scene.ts';
import { WorldPhysics } from '../../packages/blockworld/src/physics.ts';

/** A world as the chest sees it; `physics` may be held back or fail, as when it closes early. */
function world(physics) {
  return {
    physics,
    draws: 0,
    draw() {
      this.draws++;
    },
    approach() {},
    picture: () => '',
    camera: undefined,
    sync() {},
    anchor: [0, 0, 0],
    turn: 0,
  };
}

function scene() {
  const window = new Window();
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  return new ThreeChestDropScene('https://example.test/', window.document);
}

test('a world that closes before its physics is ready (React mounts twice) is no failure, and the next world is waited for', async () => {
  const chest = scene(),
    errors = [];
  chest.subscribeErrors((error) => errors.push(error));
  let closeFirst;
  const first = world(
    new Promise((_, reject) => {
      closeFirst = reject;
    }),
  );
  chest.guest.enter(first);
  const waiting = chest.awaitWorld(new AbortController().signal);
  chest.guest.leave();
  closeFirst(new Error('The world was closed.'));
  const physics = await WorldPhysics.create({ floor: 0 });
  try {
    chest.guest.enter(world(Promise.resolve(physics)));
    await waiting;
    assert.deepEqual(errors, [], 'no failure reported');
  } finally {
    physics.dispose();
    chest.dispose();
  }
});

test('a world whose physics really fails while the chest stands in it is reported', async () => {
  const chest = scene(),
    errors = [];
  chest.subscribeErrors((error) => errors.push(error));
  chest.guest.enter(world(Promise.reject(new Error('no physics'))));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(errors.length, 1);
  chest.dispose();
});

test('a chest is not shown before it has a pose: fresh from loading it would stand half sunk', () => {
  const chest = scene(),
    shown = world(new Promise(() => {}));
  chest.guest.enter(shown);
  chest.render();
  assert.equal(chest.element.hidden, true);
  assert.equal(
    chest.guest.root.visible,
    false,
    'not in the world either, whatever frames are drawn',
  );
  chest.dispose();
});
