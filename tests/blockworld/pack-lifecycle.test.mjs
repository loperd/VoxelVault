import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Color,
  Group,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NoToneMapping,
  Scene,
  SRGBColorSpace,
} from 'three';
import { readWorldPack } from '../../packages/blockworld/src/pack/read.ts';
import { loadPackAssets, packDiagnostics } from '../../packages/blockworld/src/pack/assets.ts';
import { packStage } from '../../packages/blockworld/src/pack/stage.ts';
import { BlockView, preloadStage } from '../../packages/blockworld/src/view.ts';
import { fakePage, memoryFiles, packFolder, never, png } from './pack-fixture.mjs';

const sample = await packFolder();
const files = (options = {}) => memoryFiles(sample, options);
const pack = await readWorldPack(files(), { signal: never });
const ticks = (n) =>
  new Promise((resolve) => {
    let left = n;
    const step = () => (left-- <= 0 ? resolve() : setTimeout(step, 0));
    step();
  });
const settled = () =>
  assert.deepEqual(
    { assets: packDiagnostics.assets, resources: packDiagnostics.resources },
    { assets: 0, resources: 0 },
    'nothing of a pack is left alive',
  );
const disposed = (object) => {
  let fired = false;
  object.addEventListener('dispose', () => {
    fired = true;
  });
  return () => fired;
};
const meshes = (root) => {
  const found = [];
  root.traverse((o) => {
    if (o instanceof Mesh) found.push(o);
  });
  return found;
};

test('two stages of one PackAssets: two roots, own world meshes, borrowed model resources', async () => {
  const assets = await loadPackAssets(pack, { signal: never });
  const builder = packStage(assets, { camera: 'hero', anchor: 'altar' });
  assert.equal(builder.cache, false);
  const one = builder.build(1),
    two = builder.build(1);
  assert.notEqual(one.root, two.root, 'never one root for two views');
  assert.notEqual(
    one.living,
    two.living,
    'each view updates the living things of its own stage only',
  );
  assert.equal(assets.instances, 2);
  const template = meshes(assets.template('brazier'));
  const [worldOne, worldTwo] = [one, two].map((stage) =>
    meshes(stage.root).filter((m) => m.userData.blockworldPass),
  );
  assert.ok(
    worldOne.length &&
      worldOne.every(
        (m, i) => m.geometry !== worldTwo[i].geometry && m.material !== worldTwo[i].material,
      ),
    "world meshes are each instance's own",
  );
  const clones = meshes(one.objects);
  assert.ok(
    clones.every((c) =>
      template.some((t) => t.geometry === c.geometry && t.material === c.material),
    ),
    "model clones borrow the template's geometry and materials",
  );
  const templateGone = template.map((t) => disposed(t.geometry)),
    worldOneGone = worldOne.map((m) => disposed(m.geometry)),
    worldTwoGone = worldTwo.map((m) => disposed(m.geometry));

  new Scene().add(one.root);
  one.dispose();
  assert.equal(one.root.parent, null);
  assert.ok(
    worldOneGone.every((f) => f()),
    'the instance freed its own meshes',
  );
  assert.ok(
    !templateGone.some((f) => f()) && !worldTwoGone.some((f) => f()),
    'nothing borrowed, nothing of the other instance',
  );
  one.dispose();
  assert.equal(assets.instances, 1, 'a second dispose does nothing');
  assert.throws(() => assets.release(), /still used by 1 stage/);
  two.dispose();
  assets.release();
  assets.release();
  assert.ok(
    templateGone.every((f) => f()),
    'release frees the templates',
  );
  assert.throws(() => builder.build(1), /were released; load it again/);
  settled();
});

test("the stage: camera and anchor from the pack's names, the guest faces the marker's front, light from its marker", async () => {
  const assets = await loadPackAssets(pack, { signal: never });
  const stage = packStage(assets, { camera: 'hero', anchor: 'altar' }).build(1);
  const altar = pack.markers.get('altar'),
    lamp = pack.markers.get('lamp');
  assert.deepEqual(stage.anchor, altar.at);
  assert.deepEqual(stage.anchorFront, [0, 1]);
  assert.deepEqual(stage.camera.position, pack.cameras.get('hero').eye);
  assert.deepEqual(stage.camera.target, altar.at);
  assert.deepEqual(
    stage.light.from,
    [0, 1, 2].map((i) => lamp.at[i] - altar.at[i]),
    "the guest's key comes from the lamp",
  );
  assert.equal(stage.light.keyStrength, 4);
  assert.equal(stage.light.key, '#ffc890');
  // The guest stands on blocks that are there: the dais under the altar is solid ground.
  const { world, registry } = stage.ground.blocks,
    [ox, oy, oz] = world.origin;
  assert.ok(
    registry.get(world.get(altar.at[0] - ox - 0.5, altar.at[1] - oy - 1, altar.at[2] - oz - 0.5))
      ?.opaque,
  );
  assert.throws(
    () => packStage(assets, { camera: 'nope' }),
    /no camera "nope" \(it has hero, high\)/,
  );
  assert.throws(() => packStage(assets, { camera: 'hero', anchor: 'nope' }), /no marker "nope"/);
  stage.dispose();
  assets.release();
  settled();
});

test("cancelled at any point of loading: it rejects with the signal's reason and frees all it made", async () => {
  for (let wait = 0; wait <= 12; wait++) {
    const controller = new AbortController(),
      loading = loadPackAssets(pack, { signal: controller.signal });
    await ticks(wait);
    controller.abort();
    const result = await loading.then(
      (assets) => assets,
      (error) => error,
    );
    // Late enough, the load had already finished: then the caller holds it and releases it.
    if (result instanceof Error) assert.equal(result.name, 'AbortError', `wait ${wait}`);
    else result.release();
    settled();
  }
});

test('a broken PNG or GLB inside a pack that passed its checks: the load fails and frees what it made', async () => {
  const broken = (name, data) => ({
    ...pack,
    [name]: () => data.buffer.slice(0),
    textureNames: pack.textureNames,
    modelNames: pack.modelNames,
  });
  const png = new Uint8Array(pack.texture('ruin_moss'));
  png[png.length - 16] ^= 0xff;
  await assert.rejects(
    loadPackAssets(broken('texture', png), { signal: never }),
    /Texture ".*": PNG: /,
  );
  settled();
  const glb = new Uint8Array(pack.model('brazier'));
  new DataView(glb.buffer).setUint32(12, 0xffff, true);
  await assert.rejects(loadPackAssets(broken('model', glb), { signal: never }), /Model "brazier"/);
  settled();
});

test('a build that fails part way frees what it made and borrows nothing', async () => {
  const assets = await loadPackAssets(pack, { signal: never });
  const template = assets.template,
    before = packDiagnostics.resources;
  assets.template = () => {
    throw new Error('the model went away');
  };
  assert.throws(() => packStage(assets, { camera: 'hero' }).build(1), /the model went away/);
  assert.equal(assets.instances, 0);
  assert.equal(packDiagnostics.resources, before);
  assets.template = template;
  assets.release();
  settled();
});

/** The app's effect (docs §1.5), with a stand-in for BlockView that owns its stage the same way. */
function effect(read) {
  const abort = new AbortController(),
    state = {};
  let assets, view;
  state.done = (async () => {
    const loaded = await loadPackAssets(await readWorldPack(read, { signal: abort.signal }), {
      signal: abort.signal,
    });
    if (abort.signal.aborted) {
      loaded.release();
      return;
    }
    assets = loaded;
    const stage = packStage(loaded, { camera: state.camera ?? 'hero', anchor: 'altar' }).build(1);
    view = { stage, dispose: () => stage.dispose() };
  })().catch((error) => {
    view?.dispose();
    assets?.release();
    view = assets = undefined;
    if (!abort.signal.aborted) state.fallback = error;
  });
  state.view = () => view;
  state.cleanup = () => {
    abort.abort();
    view?.dispose();
    assets?.release();
  };
  return state;
}
/** PackFiles that hold `path` back until `release()` is called. */
function held(path, options) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const read = files({ ...options, gate: (p) => (p === path ? gate : undefined) });
  return { read, release: () => release() };
}

test('the effect: switched away while reading, while loading, after loading; errors; A→B→C with A last', async () => {
  // 1. During readWorldPack.
  {
    const a = held('structure.u16'),
      e = effect(a.read);
    e.cleanup();
    a.release();
    await e.done;
    assert.equal(e.fallback, undefined);
    settled();
  }
  // 2 and 3. During loadPackAssets, and after it (each tick a later step).
  for (let wait = 0; wait <= 12; wait++) {
    const e = effect(files());
    await ticks(wait);
    e.cleanup();
    await e.done;
    settled();
  }
  // 4. A PNG that does not decode (its header is fine, its data is not).
  {
    const png = new Uint8Array(sample.get('textures/ruin_moss.png').slice(0));
    png[png.length - 16] ^= 0xff;
    const e = effect(files({ swap: { 'textures/ruin_moss.png': png } }));
    await e.done;
    assert.match(String(e.fallback), /PNG/);
    settled();
  }
  // 5. A GLB the loader cannot parse.
  {
    const glb = new Uint8Array(sample.get('models/brazier.glb').slice(0));
    const view = new DataView(glb.buffer);
    // Its JSON chunk's length points past the file: the pack check refuses it before the loader.
    view.setUint32(12, view.getUint32(12, true) + 4, true);
    const e = effect(files({ swap: { 'models/brazier.glb': glb } }));
    await e.done;
    assert.match(String(e.fallback), /brazier/);
    settled();
  }
  // 6. Between loading and the view: a camera the pack does not have.
  {
    const e = effect(files());
    e.camera = 'nope';
    await e.done;
    assert.match(String(e.fallback), /no camera "nope"/);
    settled();
  }
  // 7 is the build failing part way (the test above) and the view failing to open (the next one).
  // 8. A, then B, then C; A's reading finishes last of all. Only C is shown.
  {
    const a = held('structure.u16'),
      b = held('textures/ruin_floor.png');
    const ea = effect(a.read);
    ea.cleanup();
    const eb = effect(b.read);
    eb.cleanup();
    const ec = effect(files());
    await ec.done;
    b.release();
    await eb.done;
    a.release();
    await ea.done;
    assert.ok(ec.view(), 'C is shown');
    assert.equal(ea.view(), undefined);
    assert.equal(eb.view(), undefined);
    assert.equal(packDiagnostics.assets, 1, "only C's resources are alive");
    ec.cleanup();
    settled();
  }
});

test('ten loads and releases: nothing grows', async () => {
  for (let i = 0; i < 10; i++) {
    const assets = await loadPackAssets(await readWorldPack(files(), { signal: never }), {
      signal: never,
    });
    const stage = packStage(assets, { camera: 'hero', anchor: 'altar' }).build(1);
    assert.ok(packDiagnostics.resources > 0);
    stage.dispose();
    assets.release();
    settled();
  }
});

/** An element whose view cannot open (no WebGL in Node): the constructor fails after build(). */
function element() {
  const listeners = new Set(),
    document = {
      addEventListener: (_, f) => listeners.add(f),
      removeEventListener: (_, f) => listeners.delete(f),
    };
  document.defaultView = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    devicePixelRatio: 1,
    performance,
  };
  return { ownerDocument: document, listeners, prepend() {} };
}

test('a view that fails to open frees its stage and leaves the world showable', async () => {
  const assets = await loadPackAssets(pack, { signal: never });
  const host = element();
  assert.throws(() => new BlockView(host, packStage(assets, { camera: 'hero', anchor: 'altar' })));
  assert.equal(assets.instances, 0, 'the stage the view built for itself is freed');
  assert.equal(host.listeners.size, 0);
  assets.release();
  settled();
  // A cached (built-in) world: the failed view takes its root out again, so the next view is not refused.
  const root = new Group(),
    stage = {
      root,
      living: [],
      sky: { top: '#000000', horizon: '#000000', bottom: '#000000' },
      fog: { color: '#000000', near: 1, far: 2 },
      camera: { position: [0, 0, 5], target: [0, 0, 0] },
    };
  const builtIn = { id: 'built-in-test', build: () => stage };
  for (let i = 0; i < 2; i++)
    assert.throws(
      () => new BlockView(element(), builtIn),
      (error) => !/already shown/.test(error.message),
    );
  assert.equal(root.parent, null);
});

test('a cached world shown by a live view: a second view is refused before its root moves', () => {
  const root = new Group(),
    live = new Scene();
  const stage = {
    root,
    living: [],
    sky: { top: '#000000', horizon: '#000000', bottom: '#000000' },
    fog: { color: '#000000', near: 1, far: 2 },
    camera: { position: [0, 0, 5], target: [0, 0, 0] },
  };
  live.add(root);
  assert.throws(
    () => new BlockView(element(), { id: 'shown-twice', build: () => stage }),
    /"shown-twice" is already shown by another view/,
  );
  assert.equal(root.parent, live, 'the first view keeps its world');
  let built = 0;
  preloadStage({
    id: 'pack',
    cache: false,
    build: () => {
      built++;
      return stage;
    },
  });
  assert.equal(built, 0, 'a stage that is not cached is not built ahead');
});

// ── Live views: the real BlockView and WebGLRenderer on a stand-in WebGL context (fakePage) ──────────

const SKY = { top: '#000000', horizon: '#000000', bottom: '#000000' },
  FOG = { color: '#336699', near: 1, far: 2 };
const worldMaterials = (stage) =>
  meshes(stage.root)
    .filter((m) => m.userData.blockworldPass)
    .map((m) => m.material);

test("two live views of one pack: own stages; one view's graphics mode stays its own; the other goes on without the first", async () => {
  const page = fakePage();
  try {
    const assets = await loadPackAssets(pack, { signal: never });
    const builder = packStage(assets, { camera: 'hero', anchor: 'altar' });
    const a = new BlockView(page.element(), builder),
      b = new BlockView(page.element(), builder);
    assert.equal(assets.instances, 2);
    assert.notEqual(a.stage.root, b.stage.root);
    assert.notEqual(a.stage.objects, b.stage.objects);
    assert.equal(a.stage.root.parent, a.scene);
    assert.equal(a.stage.objects.parent, a.objectScene);
    const bMaterials = worldMaterials(b.stage),
      objectMaterials = meshes(b.stage.objects).map((m) => m.material);

    a.setGraphicsMode('shadow-poc');
    assert.ok(
      worldMaterials(a.stage).every((m) => m instanceof MeshLambertMaterial),
      'the first view lights its own blocks',
    );
    assert.deepEqual(worldMaterials(b.stage), bMaterials, 'the second keeps its materials');
    assert.ok(worldMaterials(b.stage).every((m) => m instanceof MeshBasicMaterial));
    assert.deepEqual(
      meshes(b.stage.objects).map((m) => m.material),
      objectMaterials,
      'the shared models are untouched',
    );
    a.setGraphicsMode('baseline');

    const bGeometry = meshes(b.stage.root).map((m) => disposed(m.geometry)),
      aStage = a.stage;
    a.dispose();
    assert.equal(aStage.root.parent, null);
    assert.equal(aStage.objects.parent, null);
    assert.equal(assets.instances, 1);
    a.dispose();
    assert.equal(assets.instances, 1, 'a second dispose does nothing');
    assert.throws(
      () => assets.release(),
      /still used by 1 stage/,
      'no release while a view shows the pack',
    );
    b.renderAt(1 / 30);
    assert.ok(b.renderMetrics.drawCalls > 0, 'the second view still draws');
    assert.ok(!bGeometry.some((gone) => gone()), 'and nothing of its stage was freed');
    b.dispose();
    assets.release();
    settled();

    // Loaded again after the release: new resources, none of the freed ones.
    const again = await loadPackAssets(pack, { signal: never });
    assert.notEqual(again.atlas.texture, assets.atlas.texture);
    assert.throws(() => builder.build(1), /were released; load it again/);
    const c = new BlockView(page.element(), packStage(again, { camera: 'hero' }));
    c.renderAt(1 / 30);
    assert.ok(c.renderMetrics.drawCalls > 0);
    c.dispose();
    again.release();
    settled();
  } finally {
    page.restore();
  }
});

test('a view that fails after its stage is in the scene: root and objects leave it, the stage is freed, nothing listens', async () => {
  const page = fakePage();
  try {
    const assets = await loadPackAssets(pack, { signal: never }),
      host = page.element();
    let stage;
    const builder = packStage(assets, { camera: 'hero' }),
      build = builder.build;
    const failing = { ...builder, build: (seed) => (stage = build(seed)) };
    const window = page.document.defaultView,
      matchMedia = window.matchMedia;
    window.matchMedia = () => {
      throw new Error('no media queries');
    };
    assert.throws(() => new BlockView(host, failing), /no media queries/);
    window.matchMedia = matchMedia;
    assert.equal(stage.root.parent, null);
    assert.equal(stage.objects.parent, null);
    assert.equal(assets.instances, 0);
    assets.release();
    settled();
  } finally {
    page.restore();
  }
});

test('the passes: blocks as computed (linear, no curve), then objects in standard colour (sRGB) in the same depth', async () => {
  const page = fakePage(),
    passes = [];
  // Every render of a view's renderer, with the settings it was drawn with (render is an own property).
  const watch = (view) => {
    const renderer = view.renderer,
      render = renderer.render;
    renderer.render = (scene, camera) => {
      passes.push({
        scene,
        output: renderer.outputColorSpace,
        tone: renderer.toneMapping,
        clear: renderer.autoClear,
      });
      render.call(renderer, scene, camera);
    };
    return view;
  };
  try {
    const assets = await loadPackAssets(pack, { signal: never });
    const view = watch(new BlockView(page.element(), packStage(assets, { camera: 'hero' })));
    passes.length = 0;
    view.renderAt(0);
    assert.equal(passes.length, 2);
    const [world, objects] = passes;
    assert.ok(
      world.scene.children.includes(view.stage.root) &&
        !world.scene.getObjectById(view.stage.objects.id),
    );
    assert.deepEqual(
      [world.output, world.tone, world.clear],
      [LinearSRGBColorSpace, NoToneMapping, true],
    );
    assert.ok(objects.scene.children.includes(view.stage.objects));
    assert.deepEqual(
      [objects.output, objects.tone, objects.clear],
      [SRGBColorSpace, NoToneMapping, false],
      "sRGB out, the world's curve, the world's depth kept",
    );
    // The objects' fog is the world's fog colour, taken to the linear values that pass works in.
    const fog = new Color().setRGB(
      ...new Color(pack.environment.fog.color).toArray(),
      LinearSRGBColorSpace,
    );
    assert.ok(
      objects.scene.fog.color.equals(new Color().copy(view.fog.color).convertSRGBToLinear()),
    );
    assert.ok(Math.abs(objects.scene.fog.color.r - fog.r) < 1e-6);
    view.dispose();
    assets.release();
    settled();

    // A stage without objects (every built-in world): one pass, as before.
    const plain = watch(
      new BlockView(page.element(), {
        id: 'plain',
        build: () => ({
          root: new Group(),
          living: [],
          sky: SKY,
          fog: FOG,
          camera: { position: [0, 0, 5], target: [0, 0, 0] },
        }),
      }),
    );
    passes.length = 0;
    plain.renderAt(0);
    assert.deepEqual(
      passes.map((p) => p.output),
      [LinearSRGBColorSpace],
    );
    plain.dispose();
  } finally {
    page.restore();
  }
});

test("known limitation: liquid is drawn in the blocks' pass and writes no depth, so objects behind it are drawn over it", async () => {
  // A pool cell in the sample pack: the first free cell of its top layer.
  const json = JSON.parse(new TextDecoder().decode(sample.get('pack.json'))),
    [sx, sy] = json.structure.size;
  const cells = new Uint8Array(sample.get(json.structure.cells).slice(0)),
    view16 = new DataView(cells.buffer);
  const at = [...Array(sx).keys()]
    .map((x) => 2 * (x + sx * (sy - 1)))
    .find((i) => view16.getUint16(i, true) === 0);
  view16.setUint16(at, json.blocks.length + 1, true);
  const read = await readWorldPack(
    memoryFiles(sample, {
      edit: (j) =>
        j.blocks.push({
          name: 'pool',
          model: 'liquid',
          textures: { all: Object.keys(j.textures)[0] },
        }),
      swap: { [json.structure.cells]: cells },
    }),
    { signal: never },
  );
  const page = fakePage(),
    order = [];
  try {
    const assets = await loadPackAssets(read, { signal: never });
    const view = new BlockView(page.element(), packStage(assets, { camera: 'hero' }));
    const renderer = view.renderer,
      render = renderer.render;
    renderer.render = (scene, camera) => {
      order.push(scene);
      render.call(renderer, scene, camera);
    };
    view.renderAt(0);
    const liquid = meshes(view.stage.root).find((mesh) => mesh.userData.blockworldPass === 'wave');
    assert.ok(liquid, 'the pool is meshed with the blocks');
    assert.deepEqual(
      [liquid.material.transparent, liquid.material.depthWrite],
      [true, false],
      'blended, no depth written',
    );
    assert.ok(
      order[0].getObjectById(liquid.id) && order[1].children.includes(view.stage.objects),
      'liquid first, objects after it',
    );
    // Hence: an object behind the water passes the depth test where the water is and covers it.
    view.dispose();
    assets.release();
    settled();
  } finally {
    page.restore();
  }
});

test('Living: two stages of one builder, each updated exactly once per step of its own view', () => {
  const page = fakePage(),
    counts = [];
  try {
    const builder = {
      id: 'living',
      cache: false,
      build() {
        const count = { updates: 0 };
        counts.push(count);
        return {
          root: new Group(),
          living: [
            {
              update: () => {
                count.updates++;
              },
            },
          ],
          sky: SKY,
          fog: FOG,
          camera: { position: [0, 0, 5], target: [0, 0, 0] },
          dispose() {},
        };
      },
    };
    const a = new BlockView(page.element(), builder),
      b = new BlockView(page.element(), builder);
    assert.deepEqual(
      counts.map((c) => c.updates),
      [0, 0],
    );
    a.renderAt(1 / 30);
    assert.deepEqual(
      counts.map((c) => c.updates),
      [1, 0],
      'a step of the first view updates its own stage only',
    );
    b.renderAt(1 / 30);
    assert.deepEqual(
      counts.map((c) => c.updates),
      [1, 1],
    );
    a.renderAt(1 / 30);
    a.renderAt(1 / 30);
    assert.deepEqual(
      counts.map((c) => c.updates),
      [3, 1],
    );
    a.dispose();
    b.dispose();
  } finally {
    page.restore();
  }
});

test('PBR companions: <tile>_n and <tile>_s ride in textures, take no block tile, and free with the pack', async () => {
  const tile = (r, g, b) => png(16, 16, () => [r, g, b, 255]);
  const own = await readWorldPack(
    memoryFiles(sample, {
      edit: (json) => {
        json.textures.ruin_bricks_n = 'textures/ruin_bricks_n.png';
        json.textures.ruin_bricks_s = 'textures/ruin_bricks_s.png';
      },
      swap: {
        'textures/ruin_bricks_n.png': tile(128, 128, 255),
        'textures/ruin_bricks_s.png': tile(200, 0, 50),
      },
    }),
    { signal: never },
  );
  const assets = await loadPackAssets(own, { signal: never });
  assert.throws(() => assets.atlas.uv('ruin_bricks_n'), /no tile/, 'a map is not a block tile');
  const { normal, material } = assets.atlas.pbr;
  assert.equal(normal.image.width, assets.atlas.texture.image.width, 'laid out like the atlas');
  assert.equal(material.image.height, assets.atlas.texture.image.height);
  const [u0, v0] = assets.atlas.uv('ruin_bricks'),
    x = Math.floor(u0 * material.image.width) + 2,
    y = Math.floor(v0 * material.image.height) + 2;
  assert.deepEqual(
    [...material.image.data.subarray((y * material.image.width + x) * 4)].slice(0, 3),
    [200, 0, 50],
  );
  assets.release();
  settled();
  const plain = await loadPackAssets(pack, { signal: never });
  assert.equal(plain.atlas.pbr, undefined, 'no maps, no PBR');
  plain.release();
});
