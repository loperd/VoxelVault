import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { AnimationMixer, Box3, LoopOnce } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadChestAssets } from '../../src/adapters/outbound/chest/chest-assets.ts';
import { CHEST_WIDTH } from '../../src/adapters/outbound/chest/chest-bounds.ts';
import { createChestAppearance } from '../../src/domain/chest-appearance.ts';
import { ENDER_CASE } from '../../src/config/cases.ts';

const directory = process.env.RELIC_ASSET_DIR ?? 'assets/chests/relic-v2';
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

test('Relic export carries separate PBR stone, metal and crystal without optional extensions', async () => {
  const raw = await readFile(asset);
  const json = JSON.parse(raw.subarray(20, 20 + raw.readUInt32LE(12)));
  assert.ok(raw.length < 500_000);
  assert.equal(json.meshes.length, 14);
  assert.deepEqual(
    json.materials.map((material) => material.name),
    contract.materials,
  );
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
  assert.ok(materials.get('Vault.Shell').roughness > 0.75);
  assert.equal(materials.get('Vault.Shell').metalness, 0);
  assert.ok(materials.get('Vault.Metal').metalness > 0.7);
  assert.ok(materials.get('Vault.Metal').roughness < 0.4);
  assert.ok(materials.get('Vault.Crystal').roughness < 0.3);
  assert.ok(materials.get('Vault.Crystal').emissive.g > 0);
  assert.equal(materials.get('Vault.Shell').map.image.width, 64);
  assert.equal(materials.get('Vault.Metal').map.image.width, 16);
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
    assert.ok(metal.metalness > 0.7 && metal.roughness < 0.4);
    assets.restore();
    assert.equal(
      ENDER_CASE.model.path,
      'models/ender-chest.glb',
      'prototype does not silently replace the active case',
    );
  } finally {
    assets?.dispose();
    globalThis.fetch = originalFetch;
  }
});
