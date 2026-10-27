import assert from 'node:assert/strict';
import test from 'node:test';
import { FixedStepper } from '../../src/adapters/outbound/browser/fixed-stepper.ts';
import { FrameScheduler } from '../../src/adapters/outbound/browser/frame-scheduler.ts';

function environment() {
  const frames = new Map(),
    listeners = new Set(),
    archived = new Map();
  let number = 0,
    hidden = false;
  return {
    frames,
    listeners,
    archived,
    requestFrame(callback) {
      const id = ++number;
      frames.set(id, callback);
      archived.set(id, callback);
      return id;
    },
    cancelFrame(id) {
      frames.delete(id);
    },
    isHidden: () => hidden,
    onVisibilityChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    visibility(value) {
      hidden = value;
      for (const listener of listeners) listener();
    },
    tick(time) {
      const pending = [...frames];
      frames.clear();
      for (const [, frame] of pending) frame(time);
    },
  };
}

test('30, 60 and 120 Hz generate the same 60 physics steps per second', () => {
  for (const hz of [30, 60, 120]) {
    const stepper = new FixedStepper();
    let steps = 0;
    for (let frame = 0; frame < hz; frame++)
      stepper.advance(1 / hz, (step) => {
        assert.equal(step, 1 / 60);
        steps++;
      });
    assert.equal(steps, 60);
  }
});

test('a long frame performs at most five substeps and does not retain catch-up debt', () => {
  const stepper = new FixedStepper();
  let steps = 0;
  assert.equal(
    stepper.advance(10, () => steps++),
    5,
  );
  assert.equal(
    stepper.advance(0, () => steps++),
    0,
  );
  assert.equal(steps, 5);
  stepper.advance(1 / 120, () => steps++);
  stepper.reset();
  assert.equal(
    stepper.advance(1 / 120, () => steps++),
    0,
  );
});

test('repeated start/stop cycles retain one RAF and one visibility listener', () => {
  const env = environment(),
    deltas = [];
  const scheduler = new FrameScheduler(
    env,
    (dt) => deltas.push(dt),
    () => {},
    (error) => {
      throw error;
    },
  );
  for (let i = 0; i < 100; i++) {
    scheduler.start();
    scheduler.start();
    assert.equal(env.frames.size, 1);
    assert.equal(env.listeners.size, 1);
    env.tick(i * 1000);
    assert.equal(env.frames.size, 1);
    scheduler.stop();
    assert.equal(env.frames.size, 0);
  }
  scheduler.dispose();
  scheduler.dispose();
  assert.equal(env.frames.size, 0);
  assert.equal(env.listeners.size, 0);
  assert.equal(deltas.length, 100);
  assert.throws(() => scheduler.start(), /disposed/);
});

test('hidden tabs pause RAF and resume without a large elapsed delta', () => {
  const env = environment(),
    deltas = [];
  let resets = 0;
  const scheduler = new FrameScheduler(
    env,
    (dt) => deltas.push(dt),
    () => resets++,
    () => {},
  );
  scheduler.start();
  env.tick(1000);
  env.tick(1016);
  env.visibility(true);
  assert.equal(env.frames.size, 0);
  env.visibility(false);
  assert.equal(env.frames.size, 1);
  env.tick(61000);
  assert.equal(deltas.at(-1), 0);
  env.tick(61016);
  assert.equal(deltas.at(-1), 0.016);
  assert.ok(resets >= 3);
  scheduler.dispose();
});

test('a canceled late callback cannot erase the new RAF or update a restarted scene', () => {
  const env = environment();
  let updates = 0;
  const scheduler = new FrameScheduler(
    env,
    () => updates++,
    () => {},
    () => {},
  );
  scheduler.start();
  const oldId = [...env.frames.keys()][0];
  scheduler.stop();
  scheduler.start();
  env.archived.get(oldId)(1000);
  assert.equal(updates, 0);
  assert.equal(env.frames.size, 1);
  env.tick(2000);
  assert.equal(updates, 1);
  assert.equal(env.frames.size, 1);
  scheduler.dispose();
});

test('runtime frame errors stop the loop and are reported once', () => {
  const env = environment(),
    errors = [];
  const scheduler = new FrameScheduler(
    env,
    () => {
      throw new Error('Render failed');
    },
    () => {},
    (error) => errors.push(error),
  );
  scheduler.start();
  env.tick(1000);
  assert.equal(env.frames.size, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Render failed/);
  scheduler.dispose();
});
