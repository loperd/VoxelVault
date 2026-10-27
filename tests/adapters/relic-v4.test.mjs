import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { AnimationMixer, Box3, LoopOnce, SRGBColorSpace, NoColorSpace } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadChestAssets } from '../../src/adapters/outbound/chest/chest-assets.ts';
import { CHEST_WIDTH } from '../../src/adapters/outbound/chest/chest-bounds.ts';
import { createChestAppearance } from '../../src/domain/chest-appearance.ts';
import { ENDER_CASE } from '../../src/config/cases.ts';

const directory = 'assets/chests/relic-v4';
const asset = new URL(`../../${directory}/relic.glb`, import.meta.url);
const contract = JSON.parse(
  await readFile(new URL(`../../${directory}/contract.json`, import.meta.url), 'utf8'),
);
const originalFetch = globalThis.fetch;
globalThis.self = globalThis;
globalThis.ProgressEvent ??= class {
  constructor(type, data) {
    this.type = type;
    Object.assign(this, data);
  }
};
// No fake GPU/decode claim: PNG dimensions are real; bitmap pixels are decoded
// independently by Pillow for the CPU path-traced evidence.
globalThis.createImageBitmap = async (blob) => {
  const raw = await blob.arrayBuffer();
  const view = new DataView(raw);
  assert.equal(view.getUint32(0), 0x89504e47);
  return { width: view.getUint32(16), height: view.getUint32(20), close() {} };
};

async function load() {
  const raw = await readFile(asset);
  return new GLTFLoader().parseAsync(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    '',
  );
}

test('V4 exports all six core PBR channels with correct loader color spaces and bindings', async () => {
  const raw = await readFile(asset);
  const json = JSON.parse(raw.subarray(20, 20 + raw.readUInt32LE(12)));
  assert.ok(raw.length < contract.assetBudgetBytes);
  assert.deepEqual(
    json.materials.map((m) => m.name),
    contract.materials,
  );
  assert.equal(json.images.length, 23);
  assert.ok(
    json.images.every(
      (image) => image.bufferView !== undefined && image.mimeType === 'image/png' && !image.uri,
    ),
  );
  assert.ok(!json.extensionsRequired?.length);
  const gltf = await load();
  const materials = new Map();
  gltf.scene.traverse((object) => {
    if (object.isMesh) materials.set(object.material.name, object.material);
  });
  for (const material of materials.values()) {
    assert.ok(
      material.map &&
        material.normalMap &&
        material.roughnessMap &&
        material.metalnessMap &&
        material.aoMap,
      material.name,
    );
    assert.equal(material.map.colorSpace, SRGBColorSpace);
    for (const map of [
      material.normalMap,
      material.roughnessMap,
      material.metalnessMap,
      material.aoMap,
    ])
      assert.equal(map.colorSpace, NoColorSpace);
    assert.equal(material.metalnessMap, material.roughnessMap);
    assert.equal(material.roughnessMap, material.aoMap);
    assert.equal(material.aoMap.channel, 0);
    assert.equal(material.metalness, 1);
    assert.equal(material.roughness, 1);
    if (['Vault.Crystal', 'Vault.Accent'].includes(material.name)) {
      assert.ok(material.emissiveMap && material.emissive.g > 0 && material.emissive.g <= 1);
      assert.equal(material.emissiveMap.colorSpace, SRGBColorSpace);
    }
  }
  assert.equal(materials.get('Vault.Shell').map.image.width, 1024);
  assert.equal(materials.get('Vault.Crystal').map.image.width, 256);
});

test('Relic opens and closes through the actual exported clip, keeping body and hinge fixed', async () => {
  const gltf = await load();
  const body = gltf.scene.getObjectByName(contract.body),
    lid = gltf.scene.getObjectByName(contract.lid);
  const beforeBody = new Box3().setFromObject(body),
    beforeLid = new Box3().setFromObject(lid);
  const hinge = lid.position.clone();
  const mixer = new AnimationMixer(gltf.scene);
  const action = mixer.clipAction(
    gltf.animations.find((clip) => clip.name === contract.openingClips[0]),
  );
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.setTime(1);
  gltf.scene.updateMatrixWorld(true);
  const after = new Box3().setFromObject(lid);
  assert.ok(after.max.y > beforeLid.max.y + 0.4);
  assert.ok(lid.position.distanceTo(hinge) < 1e-8);
  assert.ok(new Box3().setFromObject(body).equals(beforeBody));
  action.paused = false;
  action.timeScale = -1;
  mixer.update(1);
  gltf.scene.updateMatrixWorld(true);
  const closed = new Box3().setFromObject(lid);
  assert.ok(
    closed.min.distanceTo(beforeLid.min) < 1e-6 && closed.max.distanceTo(beforeLid.max) < 1e-6,
  );
  const envelope = new Box3().setFromObject(gltf.scene);
  for (const axis of ['x', 'y', 'z']) {
    const i = ['x', 'y', 'z'].indexOf(axis);
    assert.ok(envelope.min[axis] >= contract.closedEnvelope.min[i] - 1e-6);
    assert.ok(envelope.max[axis] <= contract.closedEnvelope.max[i] + 1e-6);
  }
});

test('existing asset loader accepts the prototype contract and preserves authored PBR', async () => {
  const raw = await readFile(asset);
  const definition = {
    revision: contract.revision,
    path: 'models/relic-review.glb',
    body: contract.body,
    lid: contract.lid,
    rotationY: contract.rotationY,
    openingClips: contract.openingClips,
    modifications: {
      schemaVersion: 1,
      revision: 'relic-review',
      parts: [
        { id: 'body', label: 'Body', nodes: ['Body'] },
        { id: 'lid', label: 'Lid', nodes: ['LidAssembly'] },
      ],
      colorZones: [],
      catalog: [],
    },
  };
  globalThis.fetch = async (input, init) =>
    String(input).endsWith('/models/relic-review.glb')
      ? new Response(raw, { headers: { 'Content-Type': 'model/gltf-binary' } })
      : originalFetch(input, init);
  let assets;
  try {
    assets = await loadChestAssets(
      new URL('http://relic-review.local/'),
      new AbortController().signal,
      definition,
      createChestAppearance(),
    );
    assert.equal(assets.colliders.length, 2);
    assert.deepEqual(
      assets.animations.map((clip) => clip.name),
      ['Vault.Open'],
    );
    const bounds = new Box3().setFromObject(assets.visual);
    assert.ok(Math.abs(bounds.max.x - bounds.min.x - CHEST_WIDTH) < 1e-5);
    let metal;
    assets.visual.traverse((object) => {
      if (object.material?.name === 'Vault.Metal') metal = object.material;
    });
    assert.equal(metal.metalness, 1);
    assert.equal(metal.roughness, 1);
    assert.ok(metal.metalnessMap && metal.roughnessMap && metal.normalMap && metal.aoMap);
    assets.restore();
    assert.equal(
      ENDER_CASE.model.path,
      'models/ender-chest.glb',
      'review does not silently replace the active case',
    );
  } finally {
    assets?.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('V4 preserves V3 geometry buffers, UVs, hierarchy and animation exactly', async () => {
  function glb(raw) {
    const n = raw.readUInt32LE(12);
    return { json: JSON.parse(raw.subarray(20, 20 + n)), bin: raw.subarray(28 + n) };
  }
  const before = glb(
    await readFile(new URL('../../assets/chests/relic-v3-pbr/relic.glb', import.meta.url)),
  );
  const after = glb(await readFile(asset));
  for (const key of ['nodes', 'meshes', 'animations', 'accessors'])
    assert.deepEqual(after.json[key], before.json[key], key);
  assert.deepEqual(
    after.json.scenes.map((scene) => scene.nodes),
    before.json.scenes.map((scene) => scene.nodes),
  );
  const geometryViews = new Set();
  for (const a of before.json.accessors) geometryViews.add(a.bufferView);
  for (const i of geometryViews) {
    const b = before.json.bufferViews[i],
      a = after.json.bufferViews[i];
    assert.equal(a.byteLength, b.byteLength);
    assert.deepEqual(
      after.bin.subarray(a.byteOffset, a.byteOffset + a.byteLength),
      before.bin.subarray(b.byteOffset, b.byteOffset + b.byteLength),
    );
  }
  assert.equal(after.json.images.length, before.json.images.length);
  assert.equal(after.json.materials[4].emissiveFactor[1], 1);
});
