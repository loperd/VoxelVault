import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { AnimationMixer, Box3, Mesh, MeshStandardMaterial, Group, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ENDER_CASE } from '../../src/config/cases.ts';
import {
  applyChestPalette,
  chestEffectColor,
} from '../../src/adapters/outbound/chest/chest-appearance.ts';
import { createChestAppearance, changeChestAppearance } from '../../src/domain/chest-appearance.ts';
import { copyModificationProfile } from '../../src/domain/chest-modifications.ts';

async function model() {
  const raw = await readFile(new URL('../../public/' + ENDER_CASE.model.path, import.meta.url));
  const length = raw.readUInt32LE(12);
  return {
    raw,
    json: JSON.parse(raw.subarray(20, 20 + length)),
    binary: raw.subarray(20 + length),
  };
}

test('active model exports one scene, embedded textures and stable part/clip names', async () => {
  const { raw, json } = await model();
  // Extra scenes may exist but must be empty; the default scene carries the chest.
  assert.ok(json.scenes.filter((scene) => scene.nodes?.length).length === 1);
  assert.ok(json.scenes[json.scene ?? 0].nodes?.length);
  for (const name of [ENDER_CASE.model.body, ENDER_CASE.model.lid])
    assert.ok(json.nodes.some((node) => node.name === name));
  assert.deepEqual(
    json.animations.map((animation) => animation.name),
    ENDER_CASE.model.openingClips,
  );
  assert.ok(json.images.length > 0);
  assert.ok(json.images.every((image) => image.bufferView !== undefined && !image.uri));
  assert.ok(raw.length < 500_000);
});

test('actual exported hinge lifts the lid while the body stays still', async () => {
  const { json, binary } = await model();
  // Browser image decoding is irrelevant to the real exported geometry/animation check.
  for (const mesh of json.meshes)
    for (const primitive of mesh.primitives) delete primitive.material;
  delete json.materials;
  delete json.images;
  delete json.textures;
  let encoded = Buffer.from(JSON.stringify(json));
  encoded = Buffer.concat([encoded, Buffer.alloc((4 - (encoded.length % 4)) % 4, 32)]);
  const header = Buffer.alloc(20);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + encoded.length + binary.length, 8);
  header.writeUInt32LE(encoded.length, 12);
  header.write('JSON', 16);
  const glb = Buffer.concat([header, encoded, binary]);
  const gltf = await new GLTFLoader().parseAsync(
    glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength),
    '',
  );
  const body = gltf.scene.getObjectByName(ENDER_CASE.model.body),
    lid = gltf.scene.getObjectByName(ENDER_CASE.model.lid);
  const beforeBody = new Box3().setFromObject(body),
    beforeLid = new Box3().setFromObject(lid);
  const mixer = new AnimationMixer(gltf.scene);
  mixer.clipAction(gltf.animations[0]).play();
  mixer.update(gltf.animations[0].duration - 0.001);
  gltf.scene.updateMatrixWorld(true);
  const afterBody = new Box3().setFromObject(body),
    afterLid = new Box3().setFromObject(lid);
  assert.ok(afterBody.min.distanceTo(beforeBody.min) < 1e-6);
  assert.ok(afterBody.max.distanceTo(beforeBody.max) < 1e-6);
  assert.ok(afterLid.max.y > beforeLid.max.y + 0.5);
  assert.ok(beforeLid.min.y > beforeBody.min.y + 0.4);
});

test('palette follows the profile zones: material replace, per-node tint on a shared material', () => {
  const zones = copyModificationProfile({
    schemaVersion: 1,
    revision: 't',
    catalog: [],
    parts: [{ id: 'body', label: 'Body', nodes: ['Body'] }],
    colorZones: [
      { role: 'panel', mode: 'replace', materials: ['Vault.Panel'] },
      { role: 'metal', mode: 'tint', strength: 1, nodes: ['Latch'] },
    ],
  });
  const root = new Group(),
    panel = new MeshStandardMaterial(),
    latch = new MeshStandardMaterial(),
    shared = new MeshStandardMaterial();
  panel.name = 'Vault.Panel';
  latch.name = 'Vault.Latch';
  latch.color.set('#be9a47');
  const latchBefore = latch.color.getHexString();
  const object = new Mesh(undefined, [panel, latch]);
  root.add(object);
  const body = new Mesh(undefined, shared);
  body.name = 'Body';
  const lock = new Mesh(undefined, shared);
  lock.name = 'Latch';
  root.add(body, lock);
  applyChestPalette(
    root,
    changeChestAppearance(createChestAppearance(), {
      palette: { panel: '#aa44cc', metal: '#204080' },
    }),
    zones,
  );
  assert.equal(panel.color.getHexString(), 'aa44cc');
  assert.equal(latch.color.getHexString(), latchBefore);
  assert.equal(body.material, shared);
  assert.equal(shared.color.getHexString(), 'ffffff');
  assert.notEqual(lock.material, shared);
  const hsl = lock.material.color.getHSL({});
  assert.ok(
    hsl.l >= 0.7 && hsl.h > 0.55 && hsl.h < 0.7,
    'tint keeps the hue but stays light enough for a coloured texture',
  );
  for (const value of [object, body, lock]) value.geometry.dispose();
  for (const value of [panel, latch, shared, lock.material]) value.dispose();
});

test('every node the profile names exists in the configured model', async () => {
  const { json } = await model();
  const names = new Set(json.nodes.map((node) => node.name));
  const profile = ENDER_CASE.model.modifications;
  for (const name of [
    ...profile.parts.flatMap((part) => part.nodes),
    ...profile.colorZones.flatMap((zone) => zone.nodes),
  ]) {
    assert.ok(names.has(name), `profile node ${name} is missing from ${ENDER_CASE.model.path}`);
  }
  const materials = new Set((json.materials ?? []).map((material) => material.name));
  for (const name of profile.colorZones.flatMap((zone) => zone.materials))
    assert.ok(materials.has(name), `material ${name} is missing`);
});

test('instance accent reaches opening beams, sparks, impact and fracture lights', async () => {
  const { ChestOpeningEffects } =
    await import('../../src/adapters/outbound/chest/chest-opening-effects.ts');
  const { ChestImpactEffects } =
    await import('../../src/adapters/outbound/chest/chest-impact-effects.ts');
  const { ChestFractureEffects } =
    await import('../../src/adapters/outbound/chest/chest-fracture-effects.ts');
  const { Scene } = await import('three');
  const scene = new Scene(),
    chest = new Group(),
    mesh = new Mesh();
  chest.add(mesh);
  scene.add(chest);
  const appearance = changeChestAppearance(createChestAppearance(), {
    palette: { accent: '#a84cdb' },
  });
  const color = chestEffectColor(appearance);
  assert.notEqual(color, chestEffectColor(createChestAppearance()));
  const effects = [
    new ChestOpeningEffects(chest, color),
    new ChestImpactEffects(scene, color),
    new ChestFractureEffects(chest, color, appearance),
  ];
  let lights = 0,
    tints = 0;
  try {
    scene.traverse((object) => {
      if (object.isPointLight) {
        lights++;
        assert.equal(object.color.getHex(), color);
      }
      for (const material of object.material
        ? Array.isArray(object.material)
          ? object.material
          : [object.material]
        : []) {
        if (material.uniforms?.tint) {
          tints++;
          assert.equal(material.uniforms.tint.value.getHex(), color);
        }
        if (material.isPointsMaterial || material.isSpriteMaterial)
          assert.equal(material.color.getHex(), color);
      }
    });
    assert.equal(lights, 2);
    assert.ok(tints >= 3);
  } finally {
    effects.forEach((effect) => effect.dispose());
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
});
