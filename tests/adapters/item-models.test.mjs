import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { Box3, Mesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { ITEM_VISUALS } from '../../src/config/item-visuals.ts';
import { createItemStage } from '../../src/adapters/outbound/items/item-stage.ts';

const PUBLIC = new URL('../../public/', import.meta.url);
const KINDS = new Set(['wood', 'metal', 'stone', 'cloth', 'skin', 'glow']);
/** Mobile budget per model file: download and triangles. */
const MAX_BYTES = 64 * 1024,
  MAX_TRIANGLES = 8000;

// The stage loads models through three's FileLoader (fetch, ProgressEvent); serve public/ from disk.
globalThis.ProgressEvent ??= class extends Event {
  constructor(type, init = {}) {
    super(type);
    Object.assign(this, init);
  }
};
const fetchBlob = globalThis.fetch;
globalThis.fetch = async (request, init) => {
  const url = new URL(typeof request === 'string' ? request : request.url);
  if (url.protocol === 'blob:') return fetchBlob(url, init); // a texture embedded in the GLB
  return new Response(await readFile(new URL(url.pathname.slice(1), PUBLIC)));
};
// Textures load as ImageBitmaps; Node has no decoder, and the tests never look at pixels.
globalThis.self ??= globalThis;
globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });
const load = async (path) =>
  new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .parseAsync((await readFile(new URL(path, PUBLIC))).buffer, '');
const refs = Object.values(ITEM_VISUALS).flatMap((visual) => [
  visual.model,
  ...(visual.wear ?? []),
]);

test('every model a visual names exists, fits the mobile budget and names its materials by kind', async () => {
  for (const ref of refs) {
    assert.ok(
      (await stat(new URL(ref.path, PUBLIC))).size <= MAX_BYTES,
      `${ref.path} is too large`,
    );
    const gltf = await load(ref.path);
    let triangles = 0;
    gltf.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      triangles += object.geometry.index.count / 3;
      assert.ok(
        KINDS.has(object.material.name),
        `${ref.path}: material "${object.material.name}" is not a known kind`,
      );
    });
    assert.ok(triangles > 0 && triangles <= MAX_TRIANGLES, `${ref.path}: ${triangles} triangles`);
  }
});

test('items are centred on their pivot in a unit cube; characters stand 1 tall on y 0', async () => {
  for (const [id, visual] of Object.entries(ITEM_VISUALS)) {
    const bounds = new Box3().setFromObject((await load(visual.model.path)).scene, true),
      size = bounds.getSize(new Vector3());
    if (visual.wear) {
      assert.ok(
        Math.abs(bounds.min.y) < 1e-3 && Math.abs(size.y - 1) < 0.02,
        `${id}: feet ${bounds.min.y}, height ${size.y}`,
      );
    } else {
      assert.ok(
        Math.abs(Math.max(size.x, size.y, size.z) - 1) < 1e-3,
        `${id}: largest side ${size.toArray()}`,
      );
      assert.ok(bounds.getCenter(new Vector3()).length() < 1e-3, `${id}: pivot off centre`);
    }
  }
});

test('clips, equipment bones and attachment points a visual names exist in its models', async () => {
  for (const [id, visual] of Object.entries(ITEM_VISUALS)) {
    const base = await load(visual.model.path),
      clips = base.animations.map((clip) => clip.name);
    for (const clip of [visual.idle, visual.inspect].filter(Boolean))
      assert.ok(clips.includes(clip), `${id}: no clip ${clip}`);
    for (const ref of visual.wear ?? []) {
      for (const piece of (await load(ref.path)).scene.children)
        assert.ok(
          base.scene.getObjectByName(piece.name),
          `${id}: ${ref.path} piece ${piece.name} has no bone`,
        );
    }
    for (const held of visual.hold ?? []) {
      assert.ok(base.scene.getObjectByName(held.at), `${id}: no attachment ${held.at}`);
      assert.ok(ITEM_VISUALS[held.item], `${id}: holds unknown ${held.item}`);
    }
  }
});

test('a stage frames its model, dresses it, and frees every material it made', async () => {
  for (const [id, visual] of Object.entries(ITEM_VISUALS)) {
    const stage = await createItemStage(
      new URL('http://assets.test/'),
      id,
      new AbortController().signal,
      { condition: 'heavy' },
    );
    stage.frame(0.6);
    stage.update(0.5);
    // The whole bounding sphere is in front of the camera at the narrow aspect.
    const distance = stage.camera.position.distanceTo(stage.bounds.center);
    const half = Math.atan(Math.tan((stage.camera.fov * Math.PI) / 360) * 0.6);
    assert.ok(distance * Math.sin(half) >= stage.bounds.radius, `${id}: framing cuts the model`);
    const materials = new Set(),
      freed = new Set();
    stage.scene.traverse((object) => {
      if (object instanceof Mesh) materials.add(object.material);
    });
    if (visual.hold)
      assert.ok(
        [...materials].some((material) => material.uniforms?.time),
        `${id}: the held enchanted item lost its glint`,
      );
    for (const material of materials)
      material.addEventListener('dispose', () => freed.add(material));
    stage.dispose();
    assert.equal(
      freed.size,
      materials.size,
      `${id}: ${materials.size - freed.size} materials left on the GPU`,
    );
  }
});

test('an unknown item has no stage', async () => {
  await assert.rejects(
    createItemStage(new URL('http://assets.test/'), 'nothing', new AbortController().signal),
    /no model/,
  );
});
