import assert from 'node:assert/strict';
import test from 'node:test';
import { Group } from 'three';
import { happenings } from '../../src/adapters/outbound/worlds/overworld-life.ts';

const place = {
  ground: 11,
  chest: [0, 13, 6],
  road: (z) => Math.round(Math.sin(z * 0.06) * 4),
  tint: [1, 0.78, 0.64],
};

/** Runs the world's happenings for a while with a recording chest. */
function run(only, seconds) {
  const root = new Group(),
    pulled = [],
    flashes = [],
    blasts = [];
  let state = 7;
  const rand = () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
  const life = happenings(root, place, { only, first: 0 });
  const host = {
    gust: (s, side) => pulled.push(['gust', s, side]),
    tremor: (s, t) => pulled.push(['tremor', s, t]),
    light: (c, i) => pulled.push(['light', c, i]),
  };
  const seen = new Set();
  for (let t = 0; t < seconds; t += 1 / 30) {
    life.update(
      {
        time: t,
        wind: 0,
        rand,
        host,
        gust() {},
        flash: (c, s) => flashes.push([c, s]),
        blast: (at, s) => blasts.push([at, s]),
      },
      1 / 30,
    );
    seen.add(root.children.length);
  }
  return { root, pulled, flashes, blasts, seen };
}

for (const kind of ['creeper', 'rabbit', 'flock', 'villager', 'falling-star']) {
  test(`${kind}: appears in the world and is gone again when it is over`, () => {
    let state = 0;
    const root = new Group(),
      life = happenings(root, place, { only: [kind], first: 0 });
    const rand = () => {
      state = (state * 9301 + 49297) % 233280;
      return state / 233280;
    };
    let appeared = false,
      gone = false;
    for (let t = 0; t < 60 && !gone; t += 1 / 30) {
      life.update(
        { time: t, wind: 0, rand, host: undefined, gust() {}, flash() {}, blast() {} },
        1 / 30,
      );
      if (root.children.length > 0) appeared = true;
      else if (appeared) gone = true;
    }
    assert.ok(appeared, 'it showed up');
    assert.ok(gone, 'it went away within a minute');
  });
}

test('a creeper that goes off blasts the physics, shakes, swings and lights the chest, and flashes the world', () => {
  const { pulled, flashes, blasts } = run(['creeper'], 25);
  assert.ok(blasts.length === 1 && blasts[0][1] > 0, "a real blast in the world's physics");
  assert.ok(
    pulled.some(([kind, s]) => kind === 'tremor' && s > 0.5),
    'tremor',
  );
  assert.ok(
    pulled.some(([kind]) => kind === 'gust'),
    'gust',
  );
  assert.ok(
    pulled.some(([kind]) => kind === 'light'),
    'light',
  );
  assert.ok(flashes.length > 0, 'flash');
});

test('a passing rabbit or flock leaves the chest alone', () => {
  assert.deepEqual(run(['rabbit', 'flock'], 30).pulled, []);
});
