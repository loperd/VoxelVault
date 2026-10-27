/** Actual Three DRACOLoader + shipped WASM in Node worker_threads.
 * ImageBitmap remains a dimensions stub; Pillow validates texture pixels.
 * This is decoder/loader/animation validation, not a WebGL appearance claim.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Worker as NodeWorker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import {
  AnimationMixer,
  Box3,
  LoopOnce,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  NoColorSpace,
} from 'three';
import { RELIC_CASE } from '../../src/config/cases.ts';
import { loadChestAssets } from '../../src/adapters/outbound/chest/chest-assets.ts';

const realFetch = globalThis.fetch;
globalThis.self = globalThis;
globalThis.ProgressEvent ??= class {
  constructor(type, data) {
    this.type = type;
    Object.assign(this, data);
  }
};
globalThis.createImageBitmap = async (blob) => {
  const raw = Buffer.from(await blob.arrayBuffer());
  if (raw.toString('ascii', 0, 4) === 'RIFF') {
    assert.equal(raw.toString('ascii', 8, 12), 'WEBP');
    assert.equal(raw.toString('ascii', 12, 16), 'VP8L');
    assert.equal(raw[20], 47);
    const bits = raw.readUInt32LE(21);
    return { width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1, close() {} };
  }
  assert.equal(raw.readUInt32BE(0), 0x89504e47);
  return { width: raw.readUInt32BE(16), height: raw.readUInt32BE(20), close() {} };
};
globalThis.Worker = class {
  constructor(url) {
    this.ready = realFetch(url)
      .then((response) => response.text())
      .then((source) => {
        const prefix = `const {parentPort}=require('node:worker_threads');globalThis.self=globalThis;globalThis.postMessage=(data,transfer)=>parentPort.postMessage(data,transfer);parentPort.on('message',data=>globalThis.onmessage({data}));\n`;
        this.worker = new NodeWorker(prefix + source, { eval: true });
        this.worker.on('message', (data) => this.onmessage?.({ data }));
        this.worker.on('error', (error) => {
          console.error(error);
          process.exitCode = 1;
        });
      });
  }
  postMessage(data, transfer) {
    void this.ready.then(() => this.worker.postMessage(data, transfer));
  }
  terminate() {
    void this.ready.then(() => this.worker.terminate());
  }
};
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : (input.url ?? input.href));
  if (url.origin !== 'http://relic-review.test') return realFetch(input, init);
  const path = url.pathname.slice(1);
  assert.ok(
    path.startsWith('assets/chests/') ||
      path.startsWith('vendor/draco/') ||
      path.startsWith('models/'),
    path,
  );
  return new Response(
    await readFile(
      new URL(
        '../../' +
          (path.startsWith('vendor/') || path.startsWith('models/') ? 'public/' : '') +
          path,
        import.meta.url,
      ),
    ),
  );
};
const reports = [];
try {
  for (const version of process.argv.includes('--production')
    ? ['production-relic']
    : ['relic-v3-geometry', 'relic-v3-pbr', 'relic-v4']) {
    const path =
      version === 'production-relic'
        ? RELIC_CASE.model.path
        : `assets/chests/${version}-runtime/relic.glb`;
    const raw = await readFile(
      new URL('../../' + (version === 'production-relic' ? 'public/' : '') + path, import.meta.url),
    );
    const json = JSON.parse(raw.subarray(20, 20 + raw.readUInt32LE(12)));
    const definition =
      version === 'production-relic'
        ? RELIC_CASE.model
        : {
            revision: 'runtime-compressed',
            path,
            body: 'Body',
            lid: 'LidAssembly',
            openingClips: ['Vault.Open'],
            rotationY: 0,
            modifications: {
              schemaVersion: 1,
              revision: 'authored',
              parts: [
                { id: 'body', label: 'Body', nodes: ['Body'] },
                { id: 'lid', label: 'Lid', nodes: ['LidAssembly'] },
              ],
              colorZones: [],
              catalog: [],
            },
          };
    const assets = await loadChestAssets(
      new URL('http://relic-review.test/'),
      new AbortController().signal,
      definition,
    );
    try {
      const materials = new Map();
      let triangles = 0;
      assets.visual.traverse((object) => {
        if (object instanceof Mesh) {
          triangles += object.geometry.index.count / 3;
          assert.ok(object.material instanceof MeshStandardMaterial);
          materials.set(object.material.name, object.material);
        }
      });
      assert.equal(triangles, version === 'relic-v3-geometry' ? 6388 : 6632);
      assert.equal(materials.size, 7);
      assert.equal(assets.colliders.length, 2);
      for (const material of materials.values()) {
        assert.equal(material.map.colorSpace, SRGBColorSpace);
        assert.ok(Math.max(material.map.image.width, material.map.image.height) <= 512);
        if (version !== 'relic-v3-geometry') {
          for (const map of [
            material.normalMap,
            material.metalnessMap,
            material.roughnessMap,
            material.aoMap,
          ]) {
            assert.ok(map);
            assert.equal(map.colorSpace, NoColorSpace);
          }
          if (material.name === 'Vault.Crystal') {
            assert.ok(material.emissiveMap);
            assert.equal(material.map.image.width, 256);
          }
        }
      }
      const root = assets.animationRoot,
        lid = root.getObjectByName('LidAssembly'),
        body = root.getObjectByName('Body');
      root.updateMatrixWorld(true);
      const closed = new Box3().setFromObject(lid),
        beforeBody = new Box3().setFromObject(body),
        hinge = lid.position.clone();
      const mixer = new AnimationMixer(root),
        action = mixer.clipAction(assets.animations[0]);
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
      mixer.setTime(1);
      root.updateMatrixWorld(true);
      assert.ok(new Box3().setFromObject(lid).max.y > closed.max.y + 0.4);
      assert.ok(new Box3().setFromObject(body).equals(beforeBody));
      assert.ok(lid.position.equals(hinge));
      action.paused = false;
      action.timeScale = -1;
      mixer.update(1);
      root.updateMatrixWorld(true);
      assert.ok(new Box3().setFromObject(lid).min.distanceTo(closed.min) < 1e-6);
      reports.push({
        path,
        sha256: createHash('sha256').update(raw).digest('hex'),
        bytes: raw.length,
        triangles,
        materials: materials.size,
        embeddedImages: json.images.length,
        decoder: 'production Three DRACOLoader and shipped glTF WASM, real decoding',
        loader: 'production loadChestAssets',
        animation: 'open / reverse close / fixed body and pivot passed',
        maps: 'WebP dimension stub in Node; pixels separately validated by Pillow',
        gpu: 'not tested',
      });
    } finally {
      assets.dispose();
    }
  }
} finally {
  globalThis.fetch = realFetch;
}
const reportUrl = new URL(
  process.argv.includes('--production')
    ? '../../artifacts/relic-integration/loader-validation.json'
    : '../../artifacts/relic-v4/optimization/loader-validation.json',
  import.meta.url,
);
await mkdir(new URL('.', reportUrl), { recursive: true });
await writeFile(reportUrl, JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports, null, 2));
