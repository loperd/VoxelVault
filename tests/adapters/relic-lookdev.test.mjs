import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { NoColorSpace, SRGBColorSpace } from 'three';

const manifest = JSON.parse(
  await readFile(
    new URL('../../assets/chests/relic-material-lookdev/manifest.json', import.meta.url),
  ),
);
globalThis.self = globalThis;
globalThis.ProgressEvent ??= class {
  constructor(type, data) {
    Object.assign(this, { type }, data);
  }
};
// Dimensions-only decoder. These Node checks do not claim GPU pixels.
globalThis.createImageBitmap = async (blob) => {
  const v = new DataView(await blob.arrayBuffer());
  return { width: v.getUint32(16), height: v.getUint32(20), close() {} };
};
const hash = (raw) => createHash('sha256').update(raw).digest('hex');

test('lookdev leaves the full chest frozen and uses identical geometry/UV/camera within each family', async () => {
  assert.equal(
    hash(await readFile(new URL('../../assets/chests/relic-v3-pbr/relic.glb', import.meta.url))),
    manifest.frozenChestSha256,
  );
  for (const family of ['obsidian', 'metal', 'crystal']) {
    let geometry, camera;
    for (const study of manifest.studies.filter((s) => s.family === family)) {
      const raw = await readFile(new URL(`../../${study.asset}`, import.meta.url));
      assert.equal(hash(raw), study.sha256);
      const gltf = await new GLTFLoader().parseAsync(
        raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
        '',
      );
      const parts = [];
      gltf.scene.traverse((object) => {
        if (object.isMesh)
          parts.push([
            object.name,
            ...['position', 'normal', 'uv'].map((key) =>
              hash(new Uint8Array(object.geometry.getAttribute(key).array.buffer)),
            ),
            hash(new Uint8Array(object.geometry.index.array.buffer)),
          ]);
      });
      if (!geometry) {
        geometry = parts;
        camera = study.camera;
      } else {
        assert.deepEqual(parts, geometry);
        assert.deepEqual(study.camera, camera);
      }
      let material;
      gltf.scene.traverse((object) => {
        if (object.material?.normalMap) material = object.material;
      });
      assert.ok(material && material.metalnessMap && material.roughnessMap && material.aoMap);
      assert.equal(material.map.colorSpace, SRGBColorSpace);
      for (const map of [
        material.normalMap,
        material.roughnessMap,
        material.metalnessMap,
        material.aoMap,
      ])
        assert.equal(map.colorSpace, NoColorSpace);
      if (family === 'crystal') {
        assert.ok(material.emissiveMap);
        assert.equal(material.emissiveMap.colorSpace, SRGBColorSpace);
      }
    }
  }
});
