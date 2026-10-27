import assert from 'node:assert/strict';
import test from 'node:test';
import { LIGHTING_PRESETS, readLightingPreset } from '../../packages/blockworld/src/lighting.ts';
import { presetJson } from '../../src/dev/lighting-json.ts';

const edit = (preset, change) => {
  const draft = structuredClone(preset);
  change(draft);
  return readLightingPreset(draft);
};

test("the lab's JSON is a change of the preset it started from, and reads back as the preset it saved", () => {
  for (const [name, from] of Object.entries(LIGHTING_PRESETS)) {
    const changed = edit(from, (p) => {
      p.exposure = 1.37;
      p.ambient.level = 0.061;
      p.fog.near = 3;
      p.key.strength = 3.3;
      p.sources = { ...p.sources, torch: { ...p.sources.torch, intensity: 1.8 } };
      p.sun = p.sun
        ? { ...p.sun, direction: [0.3, 0.6, 0.74] }
        : { direction: [-0.6, 0.5, 0.6], color: '#ffd2a0', intensity: 0.4, reach: 64 };
    });
    const json = JSON.parse(JSON.stringify(presetJson(changed, from)));
    assert.equal(json.base, name);
    assert.equal(json.name, `${name}-custom`);
    assert.equal(json.sky, undefined, 'what did not change is not written');
    assert.equal(
      json.lights,
      undefined,
      'its own lights neither, read back with their keys in another order',
    );
    assert.deepEqual(readLightingPreset(json), { ...changed, name: `${name}-custom` }, name);
  }
});

test('a dropped key, a sun turned off, a list and no base survive the round trip', () => {
  const from = LIGHTING_PRESETS['golden-hour'];
  const noReach = edit(from, (p) => {
    delete p.sun.reach;
  });
  assert.equal(
    presetJson(noReach, from).base,
    undefined,
    'a merge cannot remove "reach": the whole preset',
  );
  assert.deepEqual(readLightingPreset(presetJson(noReach, from)), {
    ...noReach,
    name: 'golden-hour-custom',
  });
  const night = edit(from, (p) => {
    p.sun = null;
    p.key.from = 'local';
    p.fog.glow = 0;
  });
  assert.deepEqual(readLightingPreset(presetJson(night, from)), {
    ...night,
    name: 'golden-hour-custom',
  });
  const lit = edit(from, (p) => {
    p.lights = [{ id: 'a', type: 'custom', kind: 'shot', at: '@anchor', offset: [1, 2, 3] }];
  });
  assert.deepEqual(readLightingPreset(presetJson(lit, from)).lights, lit.lights);
  assert.deepEqual(
    readLightingPreset(JSON.parse(JSON.stringify(presetJson(lit, undefined)))),
    lit,
    'complete when there is nothing to start from',
  );
});
