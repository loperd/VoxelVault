import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSpinPlan,
  DEFAULT_SPIN_SETTINGS,
  positionAt,
  spinPhaseAt,
  velocityAt,
  WIND_UP_SECONDS,
} from '../../src/domain/spin-plan.ts';
import { buildStrip, ensureTarget } from '../../src/domain/strip.ts';
import { constantRandom, item, legacyCatalog, seededRandom } from '../helpers.mjs';

const near = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} differs from ${expected}`);

test('spin stops at the exact centre of the target for every seeded prize and start position', () => {
  for (let seed = 0; seed < 100; seed += 1) {
    const random = seededRandom(seed);
    const catalog = legacyCatalog();
    const selection = ensureTarget(buildStrip(catalog, 40, random), catalog[seed % 14], random);
    const plan = createSpinPlan(selection, DEFAULT_SPIN_SETTINGS, seed * 0.71);
    near(positionAt(plan, plan.durationSeconds) % plan.slotCount, selection.targetIndex + 0.5);
    assert.ok(plan.durationSeconds >= 5 * 1.2 + 0.5);
  }
});

test('position depends on elapsed time rather than frame count, and never jumps', () => {
  const selection = ensureTarget(
    buildStrip(legacyCatalog(), 40, constantRandom()),
    legacyCatalog()[3],
    constantRandom(),
  );
  const plan = createSpinPlan(selection);
  const peak = velocityAt(plan, plan.windUpSeconds + plan.travelSeconds * 0.1); // the end of the acceleration
  for (const hz of [24, 30, 60, 120, 144]) {
    let previous = positionAt(plan, 0),
      backwards = 0;
    for (let frame = 1; frame / hz < plan.durationSeconds; frame += 1) {
      const position = positionAt(plan, frame / hz);
      if (position < previous) backwards++;
      // No step larger than the peak speed allows: phase changes are seamless.
      assert.ok(Math.abs(position - previous) <= peak / hz + 1e-9);
      assert.ok(position <= plan.endPosition);
      previous = position;
    }
    assert.ok(
      backwards <= Math.ceil((WIND_UP_SECONDS / 2) * hz),
      'only the wind-up moves backwards',
    );
    assert.equal(positionAt(plan, plan.durationSeconds + 1 / hz), plan.endPosition);
  }
  assert.equal(positionAt(plan, 0), plan.startPosition);
  near(positionAt(plan, plan.windUpSeconds), plan.startPosition);
});

test('speed is continuous across every phase boundary and zero at both ends', () => {
  const selection = ensureTarget([], item('a'), constantRandom());
  const plan = createSpinPlan(selection);
  const boundaries = [plan.windUpSeconds + plan.travelSeconds * 0.1];
  for (const at of boundaries) near(velocityAt(plan, at - 1e-7), velocityAt(plan, at + 1e-7), 1e-3);
  near(velocityAt(plan, 0), 0);
  near(velocityAt(plan, plan.durationSeconds - 1e-9), 0, 1e-6);
  assert.equal(velocityAt(plan, plan.durationSeconds), 0);
  // Numeric derivative agrees with the analytic speed.
  for (const at of [0.1, 0.6, 1.5, plan.durationSeconds / 2, plan.durationSeconds - 0.5]) {
    near(
      (positionAt(plan, at + 1e-6) - positionAt(plan, at - 1e-6)) / 2e-6,
      velocityAt(plan, at),
      1e-3,
    );
  }
  assert.equal(plan.windUpSeconds, 0, 'it runs from the first frame');
  assert.deepEqual(
    [0.1, plan.durationSeconds - 1, plan.durationSeconds].map((at) => spinPhaseAt(plan, at)),
    ['accelerating', 'decelerating', 'stopped'],
  );
});

test('legacy acceleration and rounding determine full turns in logical slot units', () => {
  const catalog = legacyCatalog();
  const selection = ensureTarget(
    buildStrip(catalog, 40, constantRandom()),
    catalog[13],
    constantRandom(),
  );
  const plan = createSpinPlan(selection);
  assert.equal(plan.fullTurns, Math.ceil((500 * 25) / 2 / (40 * 155)));
  assert.equal(plan.fullTurns, 2);
  near(
    plan.travelSeconds,
    Math.sqrt((2 * plan.distance) / (500 / 155)) * DEFAULT_SPIN_SETTINGS.timeScale,
  );
  near(plan.durationSeconds, plan.windUpSeconds + plan.travelSeconds);
});

test('invalid targets, settings, elapsed time and overflow cannot produce a spin', () => {
  const selection = ensureTarget([], item('a'), constantRandom());
  assert.throws(() => createSpinPlan({ ...selection, targetIndex: 1 }), { code: 'INVALID_TARGET' });
  assert.throws(() => createSpinPlan({ ...selection, prize: item('b') }), {
    code: 'INVALID_TARGET',
  });
  for (const patch of [
    { deceleration: 0 },
    { nominalTimeSeconds: -1 },
    { timeScale: NaN },
    { nominalTimeSeconds: 1e308 },
  ]) {
    assert.throws(() => createSpinPlan(selection, { ...DEFAULT_SPIN_SETTINGS, ...patch }), {
      code: 'INVALID_SPIN',
    });
  }
  assert.throws(() => createSpinPlan(selection, DEFAULT_SPIN_SETTINGS, -1), {
    code: 'INVALID_SPIN',
  });
  const plan = createSpinPlan(selection);
  for (const elapsed of [-1, NaN, Infinity]) {
    assert.throws(() => positionAt(plan, elapsed), { code: 'INVALID_SPIN' });
    assert.throws(() => velocityAt(plan, elapsed), { code: 'INVALID_SPIN' });
  }
});
