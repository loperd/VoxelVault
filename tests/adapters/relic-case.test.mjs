import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { CASES, RELIC_CASE } from '../../src/config/cases.ts';

test('Relic catalog, renderer contract and shipped compressed release agree', async () => {
  const economy = JSON.parse(
    await readFile(new URL('../../server/config/economy.json', import.meta.url)),
  );
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
  for (const definition of CASES) {
    const type = economy.types.find((type) => type.id === definition.id);
    assert.equal(type?.collection, definition.collectionId);
    assert.ok(type.pool.length > 0);
    assert.ok(economy.collections.some((c) => c.id === type.collection));
  }
  const bytes = await readFile(new URL('../../public/' + RELIC_CASE.model.path, import.meta.url));
  assert.ok(bytes.length < 490_000);
  const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)));
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  for (const name of [RELIC_CASE.model.body, RELIC_CASE.model.lid])
    assert.ok(gltf.nodes.some((n) => n.name === name));
  assert.deepEqual(
    gltf.animations.map((a) => a.name),
    RELIC_CASE.model.openingClips,
  );
  assert.equal(gltf.materials.length, 7);
  assert.ok(gltf.materials.some((m) => m.emissiveTexture));
  assert.ok(gltf.extensionsRequired.includes('KHR_draco_mesh_compression'));
  assert.ok(gltf.extensionsRequired.includes('EXT_texture_webp'));
  for (const [suffix, decode] of [
    ['.br', brotliDecompressSync],
    ['.gz', gunzipSync],
  ]) {
    const compressed = await readFile(
      new URL('../../public/' + RELIC_CASE.model.path + suffix, import.meta.url),
    );
    assert.deepEqual(decode(compressed), bytes);
  }
  assert.deepEqual(RELIC_CASE.model.modifications.colorZones, [], 'retain authored PBR colors');
  assert.deepEqual(
    RELIC_CASE.model.modifications.catalog,
    [],
    'do not apply Ender overlays to Relic',
  );
  for (const c of CASES.filter((c) => c.id !== 'relic'))
    assert.notEqual(c.model.path, RELIC_CASE.model.path);
});
