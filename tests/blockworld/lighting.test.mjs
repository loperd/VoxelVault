import assert from 'node:assert/strict';
import test from 'node:test';
import { ACESFilmicToneMapping, Group, Mesh, MeshStandardMaterial, PointLight } from 'three';
import { BlockRegistry } from '../../packages/blockworld/src/blocks.ts';
import { BlockWorld } from '../../packages/blockworld/src/world.ts';
import { computeLight, computeRigLight } from '../../packages/blockworld/src/light.ts';
import { meshWorld } from '../../packages/blockworld/src/mesher.ts';
import {
  LIGHTING_PRESETS,
  LOCAL_BUDGET,
  LightingError,
  merge,
  readLightingPreset,
  resolveLighting,
} from '../../packages/blockworld/src/lighting.ts';
import { PackError, readWorldPack } from '../../packages/blockworld/src/pack/read.ts';
import { loadPackAssets, packDiagnostics } from '../../packages/blockworld/src/pack/assets.ts';
import { packStage, presetOf } from '../../packages/blockworld/src/pack/stage.ts';
import { BlockView } from '../../packages/blockworld/src/view.ts';
import { fakePage, memoryFiles, packFolder, never } from './pack-fixture.mjs';

const sample = await packFolder();
const pack = await readWorldPack(memoryFiles(sample), { signal: never });
const settled = () =>
  assert.deepEqual(
    { assets: packDiagnostics.assets, resources: packDiagnostics.resources },
    { assets: 0, resources: 0 },
    'nothing of a pack is left alive',
  );
const meshes = (root) => {
  const found = [];
  root.traverse((o) => {
    if (o instanceof Mesh) found.push(o);
  });
  return found;
};
/** The baked light of a stage's blocks: every vertex colour, in order. */
const colours = (stage) =>
  meshes(stage.root)
    .filter((m) => m.userData.blockworldPass)
    .flatMap((m) => [...m.geometry.getAttribute('color').array]);
const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
const NAMES = ['warm-torchlit', 'cold-moonlight', 'golden-hour', 'dark-cinematic'];

// ── The contract ───────────────────────────────────────────────────────────────────────────────

test('the four library presets read back from their own JSON unchanged, and differ in light, not just in sky', () => {
  for (const name of NAMES)
    assert.deepEqual(
      readLightingPreset(JSON.parse(JSON.stringify(LIGHTING_PRESETS[name]))),
      LIGHTING_PRESETS[name],
      name,
    );
  const scene = {
    origin: [0, 0, 0],
    markers: new Map(),
    anchor: [0, 1, 0],
    focus: [0, 1, 0],
    rig: [{ type: 'torch', at: [2, 2, 0] }],
    emitters: [],
  };
  const lit = NAMES.map((name) => resolveLighting(LIGHTING_PRESETS[name], scene));
  const keys = new Set(
    lit.map((l) => `${l.blocks.sky}|${l.blocks.glow}|${l.objects.key}|${l.objects.keyAt}`),
  );
  assert.equal(keys.size, 4, 'each has its own block light, key colour and key direction');
  assert.ok(
    lit[1].blocks.sun && lit[2].blocks.sun && !lit[0].blocks.sun && !lit[3].blocks.sun,
    'moon and sun only where there is one',
  );
});

test('a custom preset is JSON: a change of a library preset, merged key by key; lists and null replace', () => {
  const custom = readLightingPreset({
    base: 'golden-hour',
    name: 'ember-dusk',
    sun: { intensity: 0.3 },
    fog: { glow: 0.2 },
    lights: [{ type: 'fire', at: 'altar', offset: [0, 1, 0] }],
  });
  assert.equal(custom.label, 'Golden Hour', 'kept from the base');
  assert.deepEqual(custom.sun, { ...LIGHTING_PRESETS['golden-hour'].sun, intensity: 0.3 });
  assert.equal(custom.fog.glow, 0.2);
  assert.equal(custom.fog.far, LIGHTING_PRESETS['golden-hour'].fog.far);
  assert.equal(custom.lights.length, 1);
  const night = readLightingPreset({
    base: 'cold-moonlight',
    name: 'starless',
    sun: null,
    key: { from: 'local' },
  });
  assert.equal(night.sun, null);
});

test('a preset that is wrong says every problem with its place; nothing that would change nothing is accepted', () => {
  const problems = (preset) => {
    try {
      readLightingPreset(preset);
    } catch (error) {
      assert.ok(error instanceof LightingError);
      return error.problems.map((p) => `${p.path}: ${p.message}`);
    }
    assert.fail('accepted');
  };
  const list = problems({
    base: 'warm-torchlit',
    name: 'x',
    bloom: 2,
    fog: { near: 50, far: 10 },
    sources: { candle: {} },
    lights: [{ type: 'laser', at: 'nowhere?' }],
  });
  for (const pattern of [
    /^bloom: unknown key/,
    /^fog: "far" must be past "near"/,
    /^sources\.candle: unknown key/,
    /^lights\[0\]\.type: expected one of/,
    /^lights\[0\]\.at: expected/,
  ])
    assert.ok(
      list.some((p) => pattern.test(p)),
      `${pattern} in ${list.join('; ')}`,
    );
  assert.ok(
    problems({ base: 'warm-torchlit', name: 'x', key: { from: 'sun' } }).some((p) =>
      /no sun/.test(p),
    ),
    'a key from a sun that is not there',
  );
  assert.ok(
    problems({ base: 'golden-hour', name: 'x', sun: { direction: [0, -1, 0] } }).some((p) =>
      /above the horizon/.test(p),
    ),
  );
  assert.ok(
    problems({ name: 'x' }).some((p) => /^sky: expected an object/.test(p)),
    'a preset without a base is complete',
  );
  assert.throws(() => readLightingPreset({ base: 'nope' }), /no preset "nope"/);
});

test('a preset\'s JSON cannot reach a prototype: "__proto__" is an unknown key like any other; nesting goes no deeper than the base', () => {
  const problems = (text) => {
    try {
      readLightingPreset(JSON.parse(text));
    } catch (error) {
      assert.ok(error instanceof LightingError);
      return error.problems.map((p) => `${p.path}: ${p.message}`);
    }
    assert.fail(`accepted ${text}`);
  };
  assert.deepEqual(
    problems('{"base":"warm-torchlit","__proto__":{"bloom":2,"label":"Hijacked"}}'),
    ['__proto__: unknown key (it would change nothing)'],
  );
  assert.deepEqual(problems('{"base":"warm-torchlit","fog":{"__proto__":{"near":1}}}'), [
    'fog.__proto__: unknown key (it would change nothing)',
  ]);
  assert.deepEqual(problems('{"base":"warm-torchlit","constructor":{"prototype":{"bloom":2}}}'), [
    'constructor: unknown key (it would change nothing)',
  ]);
  assert.ok(
    problems('{"__proto__":{"name":"x"},"name":"x"}').includes(
      '__proto__: unknown key (it would change nothing)',
    ),
    'without a base too',
  );
  const merged = merge(
    { fog: { near: 1 } },
    JSON.parse('{"__proto__":{"polluted":true},"fog":{"__proto__":{"polluted":true}}}'),
  );
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(Object.getPrototypeOf(merged.fog), Object.prototype);
  assert.equal(merged.polluted, undefined);
  assert.equal({}.polluted, undefined);
  let deep = '1';
  for (let i = 0; i < 100000; i++) deep = `{"a":${deep}}`;
  assert.deepEqual(
    problems(`{"base":"warm-torchlit","fog":${deep}}`),
    ['fog.a: unknown key (it would change nothing)'],
    'a hundred thousand levels: no stack overflow, one problem',
  );
  assert.deepEqual(problems(`{"base":"warm-torchlit","bloom":${deep}}`), [
    'bloom: unknown key (it would change nothing)',
  ]);
});

// ── Local sources on blocks ────────────────────────────────────────────────────────────────────

test('a local source floods the blocks as block light does: its colour, losing a level per block, stopped by a wall', () => {
  const registry = new BlockRegistry([{ name: 'stone', textures: { all: 'stone' } }]);
  const world = new BlockWorld(12, 4, 3);
  world.fill(0, 0, 0, 11, 0, 2, 1);
  world.fill(6, 1, 0, 6, 3, 2, 1); // a wall across at x 6
  computeLight(world, registry);
  const rig = computeRigLight(world, registry, [
    { cell: [2, 1, 1], level: 8, color: [1, 0.5, 0], intensity: 1, flicker: 0.1 },
  ]);
  const at = (x, y, z) => [...rig.rgb.slice(rig.index(x, y, z) * 3, rig.index(x, y, z) * 3 + 3)];
  assert.ok(at(2, 1, 1)[0] > at(4, 1, 1)[0] && at(4, 1, 1)[0] > 0, 'fades with distance');
  assert.ok(
    Math.abs(at(3, 1, 1)[1] / at(3, 1, 1)[0] - 0.5) < 1e-6 && at(3, 1, 1)[2] === 0,
    'in its own colour',
  );
  assert.deepEqual(at(7, 1, 1), [0, 0, 0], 'nothing behind the wall');
  assert.ok(rig.flicker[rig.index(2, 1, 1)] > 0);
  const two = computeRigLight(world, registry, [
    { cell: [2, 1, 1], level: 8, color: [1, 0.5, 0], intensity: 1, flicker: 0 },
    { cell: [4, 1, 1], level: 8, color: [0, 0, 1], intensity: 1, flicker: 0 },
  ]);
  const mixed = [...two.rgb.slice(rig.index(3, 1, 1) * 3, rig.index(3, 1, 1) * 3 + 3)];
  assert.ok(mixed[0] > 0 && mixed[2] > 0, 'two sources add up where they meet');

  const near = computeRigLight(world, registry, [
    { cell: [2, 1, 1], level: 4, color: [1, 1, 1], intensity: 1, flicker: 0 },
  ]);
  assert.equal(
    near.rgb[rig.index(2, 1, 1) * 3],
    rig.rgb[rig.index(2, 1, 1) * 3],
    'a short reach is as bright at its heart: reach is how far, intensity how bright',
  );
  assert.ok(
    near.rgb[rig.index(4, 1, 1) * 3] < rig.rgb[rig.index(4, 1, 1) * 3],
    'and falls off sooner',
  );

  const plain = meshWorld(world, registry, { uv: () => [0, 0, 1, 1] });
  assert.deepEqual(
    meshWorld(world, registry, { uv: () => [0, 0, 1, 1] }).opaque.colors,
    plain.opaque.colors,
    'without a rig, the mesh is as it was',
  );
  const lit = meshWorld(world, registry, { uv: () => [0, 0, 1, 1], rig });
  assert.ok(
    mean([...lit.opaque.colors]) > mean([...plain.opaque.colors]),
    'with it, the blocks around the source are lighter',
  );
  assert.equal(
    lit.opaque.positions.length,
    plain.opaque.positions.length,
    'and the geometry is the same',
  );
});

test('a source beyond the box lights the blocks as through open air, as its point light lights a model beside it', async () => {
  const registry = new BlockRegistry([{ name: 'stone', textures: { all: 'stone' } }]);
  const build = (sx, shift) => {
    const world = new BlockWorld(sx, 3, 3);
    world.fill(shift, 0, 0, shift + 5, 0, 2, 1);
    world.fill(shift + 3, 1, 0, shift + 3, 2, 2, 1); // a wall
    computeLight(world, registry);
    return world;
  };
  // The same structure with the source 3 blocks beyond its side, and with the box grown to hold it.
  const small = build(6, 0),
    grown = build(10, 4);
  const source = { level: 7, color: [1, 0.6, 0.2], intensity: 1, flicker: 0.1 };
  const outside = computeRigLight(small, registry, [{ ...source, cell: [-3, 1, 1] }]);
  const inside = computeRigLight(grown, registry, [{ ...source, cell: [1, 1, 1] }]);
  let lit = 0;
  for (let z = -1; z <= 3; z++)
    for (let y = -1; y <= 3; y++)
      for (let x = -1; x <= 6; x++) {
        const a = outside.index(x, y, z),
          b = inside.index(x + 4, y, z);
        assert.deepEqual(
          [...outside.rgb.slice(a * 3, a * 3 + 3), outside.flicker[a]],
          [...inside.rgb.slice(b * 3, b * 3 + 3), inside.flicker[b]],
          `cell ${x},${y},${z}`,
        );
        if (outside.rgb[a * 3] > 0) lit++;
      }
  assert.ok(lit > 10, 'it reaches into the box and the air around it');
  assert.equal(outside.rgb[outside.index(4, 1, 1) * 3], 0, 'not through the wall');
  assert.equal(outside.index(-2, 0, 0), -1, 'kept for one cell of air around the box, no further');
  const plain = meshWorld(small, registry, { uv: () => [0, 0, 1, 1] }),
    meshed = meshWorld(small, registry, { uv: () => [0, 0, 1, 1], rig: outside });
  assert.ok(
    mean([...meshed.opaque.colors]) > mean([...plain.opaque.colors]),
    'the blocks it reaches are lighter',
  );
  assert.equal(
    computeRigLight(small, registry, [{ ...source, cell: [-9, 1, 1] }]).rgb.some((v) => v > 0),
    false,
    'one out of reach lights nothing',
  );

  // A pack: a light 1.5 blocks beyond the ruin's north side, by the west brazier.
  const out = {
    id: 'beyond',
    type: 'custom',
    at: [3.5, 2.5, -1.5],
    range: 7,
    intensity: 1.2,
    color: '#ff8040',
  };
  const stageWith = async (rig) => {
    const read = await readWorldPack(
      memoryFiles(sample, {
        edit: (json) => {
          json.lighting.rig.push(...rig);
        },
      }),
      { signal: never },
    );
    const assets = await loadPackAssets(read, { signal: never });
    const stage = packStage(assets, { camera: 'hero', anchor: 'altar' }).build(1);
    stage.relight(LIGHTING_PRESETS['dark-cinematic']);
    const seen = { colours: colours(stage), locals: stage.locals.map((l) => l.at) };
    stage.dispose();
    assets.release();
    return seen;
  };
  const without = await stageWith([]),
    withIt = await stageWith([out]);
  const at = pack.structure.origin.map((o, i) => o + out.at[i]);
  assert.ok(
    withIt.locals.some((l) => l.every((v, i) => Math.abs(v - at[i]) < 1e-9)),
    'a point light for the brazier',
  );
  assert.notDeepEqual(withIt.colours, without.colours, "and light on the ruin's blocks");
  settled();
});

test('resolved for a scene: a source by a model lights it, though it does not reach the guest; a world light stays put, a shot light turns with the camera', () => {
  const scene = {
    origin: [0, 0, 0],
    markers: new Map(),
    anchor: [0, 0, 0],
    focus: [0, 0, 0],
    eye: [0, 2, 10],
    objects: [[8, 0, 0]],
    rig: [],
    emitters: [],
  };
  const by = { type: 'custom', at: [8, 1, 0], range: 3, intensity: 1 };
  const preset = readLightingPreset({
    base: 'dark-cinematic',
    name: 'by-model',
    lights: [by],
    key: { from: 'sun' },
    sun: { direction: [0, 1, 0], color: '#ffffff', intensity: 0.5 },
  });
  const lit = resolveLighting(preset, scene);
  assert.deepEqual(
    lit.locals.map((l) => l.at),
    [[8, 1, 0]],
    "the model's light is a point light",
  );
  assert.deepEqual(
    resolveLighting(preset, { ...scene, objects: [] }).locals,
    [],
    'which nothing would have without the model',
  );

  const split = readLightingPreset({
    base: 'dark-cinematic',
    name: 'split',
    lights: [
      { id: 'lamp', type: 'lantern', at: '@anchor', offset: [1, 2, 3] },
      { id: 'accent', kind: 'shot', type: 'custom', at: '@anchor', offset: [1, 2, 3] },
    ],
  });
  const from = (eye) =>
    resolveLighting(split, {
      ...scene,
      anchor: [4, 0, 4],
      focus: [4, 0, 4],
      objects: [],
      eye,
    }).rig.map((l) => l.at.map((v) => +v.toFixed(6)));
  assert.deepEqual(
    from([4, 2, 14]),
    [
      [5, 2, 7],
      [5, 2, 7],
    ],
    "seen from +z, the camera's frame is the world's: both as written",
  );
  assert.deepEqual(
    from([14, 2, 4]),
    [
      [5, 2, 7],
      [7, 2, 3],
    ],
    "seen from +x: the lantern where it was; the shot light still in front, still to the camera's right",
  );
  assert.deepEqual(from(undefined)[0], [5, 2, 7], 'and with no camera at all');
  assert.equal(
    LIGHTING_PRESETS['warm-torchlit'].lights.every((l) => l.kind === 'shot' && l.type === 'custom'),
    true,
  );
  for (const name of NAMES)
    assert.ok(
      LIGHTING_PRESETS[name].lights.every((l) => l.kind === 'shot'),
      `${name}: the library's own lights are shot lights, said so`,
    );
});

test('key from "local": a directional key on models and guests, at the preset\'s strength and no point light; on blocks the same source with its own strength and reach', () => {
  const scene = {
    origin: [0, 0, 0],
    markers: new Map(),
    anchor: [0, 0, 0],
    focus: [0, 0, 0],
    eye: [0, 2, 10],
    objects: [[0, 0, -6]],
    rig: [],
    emitters: [],
  };
  const lamp = (intensity) => ({
    id: 'lamp',
    type: 'custom',
    at: [1, 1, 2],
    range: 6,
    intensity,
    color: '#ffaa55',
  });
  const preset = (intensity) =>
    readLightingPreset({
      base: 'warm-torchlit',
      name: 'local-key',
      lights: [lamp(intensity)],
      key: { from: 'local', strength: 2 },
    });
  const lit = resolveLighting(preset(1), scene),
    brighter = resolveLighting(preset(2), scene);
  assert.deepEqual(lit.objects.keyAt, [1, 1, 2], "the models' key comes from the lamp's place");
  assert.deepEqual(
    lit.objects.target,
    [0, 0, 0],
    'towards the guest: one direction for every model, wherever it stands',
  );
  assert.deepEqual(lit.guest.from, [1, 1, 2], "the guest's key from the same place");
  assert.equal(
    lit.locals.some((l) => l.at.join() === '1,1,2'),
    false,
    'and no point light besides',
  );
  assert.deepEqual(
    lit.rig.map((l) => [l.at, l.intensity, l.range]),
    [[[1, 1, 2], 1, 6]],
    'the blocks have it as it is',
  );
  assert.equal(brighter.rig[0].intensity, 2, 'a brighter lamp is brighter on the blocks');
  assert.equal(
    brighter.objects.keyStrength,
    lit.objects.keyStrength,
    "the key's strength is the preset's, not the lamp's",
  );
  assert.equal(brighter.guest.keyStrength, lit.guest.keyStrength);
});

test('a shot light is a custom light from the guest; a torch, lantern, fire or lava never is', () => {
  const problems = (lights) => {
    try {
      readLightingPreset({ base: 'golden-hour', name: 'x', lights });
    } catch (error) {
      return error.problems.map((p) => `${p.path}: ${p.message}`);
    }
    return [];
  };
  assert.deepEqual(
    problems([
      { kind: 'shot', type: 'custom', at: '@anchor', offset: [0, 2, 2] },
      { kind: 'world', type: 'torch', at: [0, 1, 0] },
      { type: 'torch', at: '@anchor' },
    ]),
    [],
  );
  const list = problems([
    { kind: 'shot', type: 'custom', at: [1, 2, 3] },
    { kind: 'shot', type: 'torch', at: '@anchor' },
    { kind: 'camera', type: 'custom', at: '@anchor' },
  ]);
  for (const pattern of [
    /^lights\[0\]\.at: a shot light is placed from the guest/,
    /^lights\[1\]\.type: a torch is a light of the world/,
    /^lights\[2\]\.kind: expected one of world, shot/,
  ])
    assert.ok(
      list.some((p) => pattern.test(p)),
      `${pattern} in ${list.join('; ')}`,
    );
  for (const type of ['lantern', 'fire', 'lava'])
    assert.ok(
      problems([{ kind: 'shot', type, at: '@anchor' }]).some((p) =>
        p.includes(`a ${type} is a light of the world`),
      ),
      type,
    );
});

// ── The pack ───────────────────────────────────────────────────────────────────────────────────

test("a pack's lighting: its rig (markers checked), presets of its own over the library, a default it starts in", async () => {
  assert.equal(pack.lighting.rig.length, 2, "the sample's braziers are fire sources");
  const read = (edit) => readWorldPack(memoryFiles(sample, { edit }), { signal: never });
  const own = await read((json) => {
    json.lighting.presets = {
      vigil: { base: 'dark-cinematic', lights: [{ type: 'lantern', at: 'lamp' }] },
    };
    json.lighting.default = 'vigil';
  });
  assert.equal(own.lighting.presets.get('vigil').name, 'vigil');
  const assets = await loadPackAssets(own, { signal: never });
  const stage = packStage(assets, { camera: 'hero', anchor: 'altar' }).build(1);
  assert.equal(stage.lighting, 'vigil', 'shown in its default');
  stage.dispose();
  assets.release();
  const error = await read((json) => {
    json.lighting.rig.push({ type: 'torch', at: 'nowhere' });
    json.lighting.presets = { bad: { base: 'golden-hour', sun: { intensity: 7 } } };
    json.lighting.default = 'missing';
  }).catch((e) => e);
  assert.ok(error instanceof PackError);
  const messages = error.problems.map((p) => `${p.path}: ${p.message}`);
  for (const pattern of [
    /^pack\.lighting\.rig\[2\]\.at: no marker "nowhere"/,
    /^pack\.lighting\.presets\.bad\.sun\.intensity: expected a number/,
    /^pack\.lighting\.default: no preset "missing"/,
  ])
    assert.ok(
      messages.some((m) => pattern.test(m)),
      `${pattern} in ${messages.join('; ')}`,
    );
  settled();
});

test("relit: the blocks' baked light, the objects' lights and glow and the guest's light change; the geometry and the camera do not", async () => {
  const assets = await loadPackAssets(pack, { signal: never });
  const stage = packStage(assets, { camera: 'hero', anchor: 'altar' }).build(1);
  const own = colours(stage),
    positions = meshes(stage.root)
      .filter((m) => m.userData.blockworldPass)
      .map((m) => m.geometry.getAttribute('position').count);
  assert.equal(stage.lighting, undefined, "the pack's own light (no default preset)");
  assert.equal(stage.locals, undefined);
  assert.equal(stage.exposure, undefined);
  const seen = {};
  for (const name of NAMES) {
    stage.relight(LIGHTING_PRESETS[name]);
    assert.equal(stage.lighting, name);
    assert.deepEqual(
      meshes(stage.root)
        .filter((m) => m.userData.blockworldPass)
        .map((m) => m.geometry.getAttribute('position').count),
      positions,
      `${name}: the same geometry`,
    );
    seen[name] = {
      colours: colours(stage),
      fog: stage.fog.color,
      key: stage.light.key,
      from: stage.light.from,
      locals: stage.locals.length,
    };
    assert.ok(stage.locals.length <= LOCAL_BUDGET);
  }
  const brightness = Object.fromEntries(NAMES.map((name) => [name, mean(seen[name].colours)]));
  assert.ok(
    brightness['dark-cinematic'] < brightness['golden-hour'] &&
      brightness['dark-cinematic'] < brightness['warm-torchlit'],
    `the dark preset is darkest: ${JSON.stringify(brightness)}`,
  );
  for (const a of NAMES)
    for (const b of NAMES)
      if (a < b)
        assert.notDeepEqual(
          seen[a].colours,
          seen[b].colours,
          `${a} and ${b} light the blocks differently`,
        );
  // Warm and cold: the balance of red to blue in the blocks' light.
  const balance = (c) => {
    let r = 0,
      b = 0;
    for (let i = 0; i < c.length; i += 3) {
      r += c[i];
      b += c[i + 2];
    }
    return r / b;
  };
  assert.ok(
    balance(seen['warm-torchlit'].colours) > 1.2 && balance(seen['cold-moonlight'].colours) < 1,
    `warm is red, cold is blue: ${balance(seen['warm-torchlit'].colours)}, ${balance(seen['cold-moonlight'].colours)}`,
  );

  // The brazier's embers glow through this instance's copy, as strong as the preset says.
  const embers = meshes(stage.objects)
    .map((m) => m.material)
    .filter((m) => m instanceof MeshStandardMaterial && m.emissive.getHex() !== 0);
  const template = meshes(assets.template('brazier'))
    .map((m) => m.material)
    .find((m) => m.emissive.getHex() !== 0);
  assert.ok(embers.length && embers.every((m) => m !== template), "never the template's material");
  assert.equal(template.emissiveIntensity, 1, 'which stays as loaded');
  assert.equal(
    embers[0].emissiveIntensity,
    LIGHTING_PRESETS['dark-cinematic'].emissive * LIGHTING_PRESETS['dark-cinematic'].exposure,
  );
  const points = stage.objects.children.filter((o) => o instanceof PointLight);
  assert.equal(
    points.length,
    LOCAL_BUDGET,
    'a fixed number of point lights: switching compiles nothing',
  );

  stage.relight(undefined);
  assert.deepEqual(colours(stage), own, "back to the pack's own light, exactly");
  assert.equal(stage.lighting, undefined);
  assert.ok(
    points.every((p) => p.intensity === 0),
    'and the local lights are dark',
  );
  stage.dispose();
  assets.release();
  settled();
});

test('a hundred switches: the freed meshes are freed, nothing grows', async () => {
  const assets = await loadPackAssets(pack, { signal: never });
  const stage = packStage(assets, { camera: 'hero', anchor: 'altar' }).build(1);
  stage.relight(LIGHTING_PRESETS['warm-torchlit']);
  const resources = packDiagnostics.resources,
    before = meshes(stage.root);
  const freed = before.map((m) => {
    let gone = 0;
    m.geometry.addEventListener('dispose', () => gone++);
    m.material.addEventListener('dispose', () => gone++);
    return () => gone;
  });
  for (let i = 0; i < 100; i++) stage.relight(LIGHTING_PRESETS[NAMES[i % 4]]);
  assert.equal(packDiagnostics.resources, resources, 'as many resources as after the first switch');
  assert.ok(
    freed.every((gone) => gone() === 2),
    'every replaced geometry and material freed once',
  );
  stage.dispose();
  assert.throws(() => stage.relight(LIGHTING_PRESETS['golden-hour']), /disposed/);
  assets.release();
  settled();
});

test('two stages of one pack, two presets: each its own light; relighting one leaves the other', async () => {
  const assets = await loadPackAssets(pack, { signal: never });
  const builder = packStage(assets, { camera: 'hero', anchor: 'altar' });
  const a = builder.build(1),
    b = builder.build(1);
  a.relight(LIGHTING_PRESETS['golden-hour']);
  b.relight(LIGHTING_PRESETS['cold-moonlight']);
  const bColours = colours(b),
    bFog = b.fog,
    bKey = b.light.key;
  a.relight(LIGHTING_PRESETS['dark-cinematic']);
  assert.deepEqual(colours(b), bColours);
  assert.equal(b.fog, bFog);
  assert.equal(b.light.key, bKey);
  assert.notDeepEqual(colours(a), bColours);
  a.dispose();
  b.dispose();
  assets.release();
  settled();
});

// ── Live views ─────────────────────────────────────────────────────────────────────────────────

test('two live views, two presets: own light, own guest light; switching leaves no GPU geometry behind; the guest is told', async () => {
  const page = fakePage();
  try {
    const assets = await loadPackAssets(pack, { signal: never });
    const builder = packStage(assets, { camera: 'hero', anchor: 'altar' });
    const a = new BlockView(page.element(), builder),
      b = new BlockView(page.element(), builder);
    let worldOfGuest,
      relit = 0,
      exposures = [];
    const guest = {
      root: new Group(),
      unit: 1,
      look: { toneMapping: ACESFilmicToneMapping, exposure: 1.1 },
      enter(world) {
        worldOfGuest = world;
        world.physics.catch(() => {});
      },
      relight() {
        relit++;
      },
    };
    const renderer = b.renderer,
      render = renderer.render;
    renderer.render = (scene, camera) => {
      if (scene === b.guestScene) exposures.push(renderer.toneMappingExposure);
      render.call(renderer, scene, camera);
    };
    b.admit(guest);
    a.setLighting(LIGHTING_PRESETS['golden-hour']);
    b.setLighting(LIGHTING_PRESETS['dark-cinematic']);
    assert.equal(relit, 1, 'only the guest of the view that was relit');
    assert.equal(
      worldOfGuest.light.key,
      LIGHTING_PRESETS['dark-cinematic'].key.color,
      'and it reads the new light',
    );
    assert.notEqual(a.stage.light.key, b.stage.light.key);
    assert.equal(b.fog.near, LIGHTING_PRESETS['dark-cinematic'].fog.near);
    assert.equal(a.fog.near, LIGHTING_PRESETS['golden-hour'].fog.near);
    const guestLights = b.guestScene.children.filter((o) => o instanceof PointLight);
    assert.equal(guestLights.length, LOCAL_BUDGET);
    assert.equal(a.guestScene.children.filter((o) => o instanceof PointLight).length, LOCAL_BUDGET);
    b.renderAt(1 / 30);
    assert.ok(
      Math.abs(exposures.at(-1) - 1.1 * LIGHTING_PRESETS['dark-cinematic'].exposure) < 1e-9,
      "the guest's exposure times the preset's",
    );

    a.renderAt(1 / 30);
    const geometries = a.renderer.info.memory.geometries;
    for (let i = 0; i < 12; i++) {
      a.setLighting(LIGHTING_PRESETS[NAMES[i % 4]]);
      a.renderAt(1 / 30);
    }
    assert.equal(
      a.renderer.info.memory.geometries,
      geometries,
      'the renderer holds as many geometries as before the switches',
    );
    a.setGraphicsMode('shadow-poc');
    a.setLighting(LIGHTING_PRESETS['warm-torchlit']);
    assert.ok(
      meshes(a.stage.root)
        .filter((m) => m.userData.blockworldPass)
        .every((m) => m.material.type === 'MeshLambertMaterial'),
      'the shadow experiment carries over to the new meshes',
    );
    a.setGraphicsMode('baseline');
    a.setLighting(undefined);
    assert.ok(
      a.guestScene.children.filter((o) => o instanceof PointLight).every((l) => l.intensity === 0),
    );

    a.dispose();
    assert.equal(
      a.guestScene.children.filter((o) => o instanceof PointLight).length,
      0,
      "the view's lights leave with it",
    );
    b.renderAt(1 / 30);
    assert.ok(b.renderMetrics.drawCalls > 0, 'the other view goes on');
    b.dismiss(guest);
    b.dispose();
    assets.release();
    settled();
  } finally {
    page.restore();
  }
});

test("one pack, two views, two cameras: the braziers and a world light where the world has them in both; a shot light in each camera's frame", async () => {
  const page = fakePage();
  try {
    const assets = await loadPackAssets(pack, { signal: never });
    // Only the sources under test reach the guest: no glowing blocks, the key from the sun.
    const preset = readLightingPreset({
      base: 'golden-hour',
      name: 'two-cameras',
      blockLight: { intensity: 0 },
      key: { from: 'sun' },
      lights: [
        { id: 'over', type: 'lantern', at: '@anchor', offset: [1, 2, 0] },
        { id: 'accent', kind: 'shot', type: 'custom', at: '@anchor', offset: [-1.3, 1.4, 2] },
      ],
    });
    const views = Object.fromEntries(
      ['hero', 'high'].map((camera) => [
        camera,
        new BlockView(page.element(), packStage(assets, { camera, anchor: 'altar' })),
      ]),
    );
    for (const view of Object.values(views)) view.setLighting(preset);
    // Markers are read into scene coordinates; a rig's numbers are in the pack's frame, from the structure's corner.
    const origin = pack.structure.origin,
      scene = (at) => [at[0] + origin[0], at[1] + origin[1], at[2] + origin[2]];
    const anchor = pack.markers.get('altar').at;
    assert.deepEqual(anchor, [-0.5, 3, -0.5]);
    const braziers = pack.lighting.rig.map((source) => scene(source.at)),
      over = [anchor[0] + 1, anchor[1] + 2, anchor[2]];
    /** The shot offset in a camera's frame, as scene coordinates: x to its right, y up, z towards it, level. */
    const shot = (camera) => {
      const eye = pack.cameras.get(camera).eye,
        [dx, dz] = [eye[0] - anchor[0], eye[2] - anchor[2]],
        l = Math.hypot(dx, dz),
        [tx, tz] = [dx / l, dz / l],
        [x, y, z] = [-1.3, 1.4, 2];
      return [anchor[0] + x * tz + z * tx, anchor[1] + y, anchor[2] - x * tx + z * tz];
    };
    const round = (at) => at.map((v) => +v.toFixed(5));
    const sorted = (list) => list.map(round).sort((a, b) => String(a).localeCompare(String(b)));
    assert.deepEqual(
      round(pack.cameras.get('high').eye),
      [9, 11, 9],
      'the high camera, in scene coordinates',
    );
    assert.deepEqual(
      round(shot('high')),
      round([
        -0.5 + (-1.3 * 0.7071067811865476 + 2 * 0.7071067811865476),
        4.4,
        -0.5 + (1.3 * 0.7071067811865476 + 2 * 0.7071067811865476),
      ]),
    );
    for (const camera of ['hero', 'high']) {
      const view = views[camera],
        expected = sorted([...braziers, over, shot(camera)]);
      assert.deepEqual(
        sorted(view.stage.locals.map((l) => l.at)),
        expected,
        `${camera}: the objects' point lights`,
      );
      assert.deepEqual(
        sorted(
          view.guestScene.children
            .filter((o) => o instanceof PointLight)
            .map((o) => o.position.toArray()),
        ),
        expected,
        `${camera}: the guest's point lights, the same places`,
      );
    }
    assert.notDeepEqual(
      round(shot('hero')),
      round(shot('high')),
      'the two cameras put the shot light in two places',
    );
    for (const view of Object.values(views)) view.dispose();
    assets.release();
    settled();
  } finally {
    page.restore();
  }
});

test("a shot light is placed for the stage's camera when the light is applied; moving the live camera neither moves it nor re-meshes; applying again places it the same", async () => {
  const page = fakePage();
  try {
    const assets = await loadPackAssets(pack, { signal: never });
    const preset = readLightingPreset({
      base: 'golden-hour',
      name: 'moving-camera',
      blockLight: { intensity: 0 },
      key: { from: 'sun' },
      lights: [
        { id: 'accent', kind: 'shot', type: 'custom', at: '@anchor', offset: [-1.3, 1.4, 2] },
      ],
    });
    const view = new BlockView(
      page.element(),
      packStage(assets, { camera: 'hero', anchor: 'altar' }),
    );
    let world;
    const guest = {
      root: new Group(),
      unit: 1,
      look: { toneMapping: ACESFilmicToneMapping, exposure: 1 },
      enter(w) {
        world = w;
        w.physics.catch(() => {});
      },
    };
    view.admit(guest);
    view.setLighting(preset);
    const anchor = pack.markers.get('altar').at;
    /** Where the shot light would be for a camera at `eye`. */
    const shotFor = (eye) => {
      const [dx, dz] = [eye[0] - anchor[0], eye[2] - anchor[2]],
        l = Math.hypot(dx, dz),
        [tx, tz] = [dx / l, dz / l];
      return [anchor[0] - 1.3 * tz + 2 * tx, anchor[1] + 1.4, anchor[2] + 1.3 * tx + 2 * tz];
    };
    const accent = () =>
      view.stage.locals.map((l) => l.at).find((at) => Math.abs(at[1] - 4.4) < 1e-9);
    const guestLights = () =>
      view.guestScene.children
        .filter((o) => o instanceof PointLight)
        .map((o) => o.position.toArray());
    const placed = accent(),
      inGuestPass = guestLights(),
      blocks = meshes(view.stage.root).filter((m) => m.userData.blockworldPass),
      baked = colours(view.stage);
    assert.deepEqual(
      placed,
      shotFor(pack.cameras.get('hero').eye),
      "placed in the frame of the stage's camera",
    );

    // The live camera moves: its drift over time, then a guest moving it in on itself.
    view.renderAt(1 / 30);
    const start = view.camera.position.toArray();
    for (let i = 0; i < 300; i++) view.renderAt(1 / 30);
    world.approach(0.6, 0.5);
    view.renderAt(1 / 30);
    const live = view.camera.position.toArray();
    assert.ok(Math.hypot(...live.map((v, i) => v - start[i])) > 3, 'the camera did move');
    assert.ok(
      Math.hypot(...shotFor(live).map((v, i) => v - placed[i])) > 1e-3,
      'far enough that following it would show',
    );
    assert.deepEqual(accent(), placed, 'the shot light stays where it was placed');
    assert.deepEqual(guestLights(), inGuestPass, "in the guest's pass too");
    const now = meshes(view.stage.root).filter((m) => m.userData.blockworldPass);
    assert.ok(
      now.length === blocks.length && now.every((m, i) => m === blocks[i]),
      'no re-mesh: the same block meshes',
    );
    assert.deepEqual(colours(view.stage), baked, 'with the same baked light');

    // Applying the light again is the one recalculation, and a re-mesh: for the stage's camera, not where the live one is.
    view.setLighting(preset);
    assert.deepEqual(
      accent(),
      placed,
      "placed again the same: the shot belongs to the stage's camera",
    );
    assert.ok(
      meshes(view.stage.root)
        .filter((m) => m.userData.blockworldPass)
        .every((m) => !blocks.includes(m)),
      'new block meshes',
    );
    view.dismiss(guest);
    view.dispose();
    assets.release();
    settled();
  } finally {
    page.restore();
  }
});

test("a world that cannot be relit says so; the pack's default preset by name", async () => {
  const page = fakePage();
  try {
    const view = new BlockView(page.element(), {
      id: 'plain-lighting',
      cache: false,
      build: () => ({
        root: new Group(),
        living: [],
        sky: { top: '#000000', horizon: '#000000', bottom: '#000000' },
        fog: { color: '#000000', near: 1, far: 2 },
        camera: { position: [0, 0, 5], target: [0, 0, 0] },
        dispose() {},
      }),
    });
    assert.throws(() => view.setLighting(LIGHTING_PRESETS['golden-hour']), /cannot be relit/);
    view.dispose();
  } finally {
    page.restore();
  }
  assert.equal(presetOf(pack, 'golden-hour'), LIGHTING_PRESETS['golden-hour']);
  assert.throws(() => presetOf(pack, 'nope'), /No lighting preset "nope"/);
});
