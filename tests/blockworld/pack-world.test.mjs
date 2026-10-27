import assert from 'node:assert/strict';
import test from 'node:test';
import { packDiagnostics } from '../../packages/blockworld/src/pack/assets.ts';
import { LIGHTING_PRESETS } from '../../packages/blockworld/src/lighting.ts';
import { packStage } from '../../packages/blockworld/src/pack/stage.ts';
import { BlockView } from '../../packages/blockworld/src/view.ts';
import { loadPackWorld, PACK_LIGHT } from '../../src/adapters/outbound/worlds/packs.ts';
import { fakePage, memoryFiles, packFolder, never } from './pack-fixture.mjs';

// The app's way into a pack (PixelWorldBackground): load, stage from the pack's own data, relight, let go.
const sample = await packFolder();
const settled = () =>
  assert.deepEqual(
    { assets: packDiagnostics.assets, resources: packDiagnostics.resources },
    { assets: 0, resources: 0 },
    'nothing of a pack is left alive',
  );

test("a pack world: the chest on its guest marker, its own light first, then the library's presets", async () => {
  const world = await loadPackWorld('sample', { signal: never, files: memoryFiles(sample) });
  assert.deepEqual(
    world.lighting.map((choice) => choice.name),
    [PACK_LIGHT, ...Object.keys(LIGHTING_PRESETS)],
  );
  assert.equal(world.preset(PACK_LIGHT), undefined, "the pack's own light is the stage's own");
  assert.equal(world.preset('golden-hour'), LIGHTING_PRESETS['golden-hour']);
  const page = fakePage();
  try {
    const view = new BlockView(page.element(), world.stage),
      named = packStage(world.assets, { camera: 'hero', anchor: 'altar' }).build(1);
    assert.deepEqual(
      view.stage.anchor,
      named.anchor,
      'the chest stands on the marker tagged guest, not a made-up place',
    );
    named.dispose();
    // A → B → A of the light, as the player picks it.
    for (const name of ['warm-torchlit', 'cold-moonlight', PACK_LIGHT])
      view.setLighting(world.preset(name));
    assert.equal(view.stage.lighting, undefined, "back to the pack's own light");
    view.dispose();
  } finally {
    page.restore();
    world.assets.release();
  }
  settled();
});

test("a pack's own presets are offered after the library's, one of the same name in its place; its default is its own light", async () => {
  const preset = { ...LIGHTING_PRESETS['golden-hour'], label: 'Ruin dusk' };
  const files = memoryFiles(sample, {
    edit: (json) => {
      json.lighting = {
        ...json.lighting,
        presets: { 'golden-hour': preset, dusk: { ...preset, name: 'dusk', label: 'Dusk' } },
        default: 'dusk',
      };
    },
  });
  const world = await loadPackWorld('sample', { signal: never, files });
  assert.deepEqual(
    world.lighting.map((choice) => choice.label),
    ['Свет пака', 'Warm Torchlit', 'Cold Moonlight', 'Ruin dusk', 'Dark Cinematic', 'Dusk'],
  );
  assert.deepEqual(
    world.preset(PACK_LIGHT),
    world.preset('dusk'),
    "the pack's light is the default preset it names",
  );
  const page = fakePage();
  try {
    const view = new BlockView(page.element(), world.stage);
    assert.equal(view.stage.lighting, 'dusk', 'opened in its default preset');
    view.setLighting(world.preset('cold-moonlight'));
    assert.equal(view.stage.lighting, 'cold-moonlight');
    view.setLighting(world.preset(PACK_LIGHT));
    assert.equal(
      view.stage.lighting,
      'dusk',
      "back to the pack's light is back to how it opened, not to its environment",
    );
    view.dispose();
  } finally {
    page.restore();
    world.assets.release();
  }
  settled();
});

test('a pack the chest cannot stand in is refused, holding nothing', async () => {
  const files = memoryFiles(sample, {
    edit: (json) => {
      for (const marker of Object.values(json.markers)) delete marker.tags;
    },
  });
  await assert.rejects(
    loadPackWorld('sample', { signal: never, files }),
    /takes no chest: it needs a camera and a marker tagged "guest"/,
  );
  settled();
});

test("given up while loading: the signal's reason, nothing kept", async () => {
  const controller = new AbortController();
  const files = memoryFiles(sample, {
    gate: (path) => {
      if (path.endsWith('.png')) controller.abort();
    },
  });
  await assert.rejects(
    loadPackWorld('sample', { signal: controller.signal, files }),
    (error) => error.name === 'AbortError',
  );
  settled();
});

test('a missing file of a pack fails the load with its path', async () => {
  const files = memoryFiles(sample, { swap: { 'structure.u16': undefined } });
  await assert.rejects(loadPackWorld('sample', { signal: never, files }), /structure\.u16/);
  settled();
});
