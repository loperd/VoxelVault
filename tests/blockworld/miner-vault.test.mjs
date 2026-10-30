import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Box3, Group, InstancedMesh, PerspectiveCamera, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ENDER_CASE } from '../../src/config/cases.ts';
import { PREVIEW_POSE } from '../../src/adapters/outbound/chest/physics-config.ts';
import {
  CHEST_WIDTH,
  normalizeChestBounds,
} from '../../src/adapters/outbound/chest/chest-bounds.ts';
import { MINER_VAULT } from '../../src/adapters/outbound/worlds/miner/index.ts';

// Canvas is used only for the embroidered banner texture; geometry needs no WebGL.
function withCanvas(run) {
  const original = globalThis.document;
  const context = new Proxy({}, { get: () => () => {} });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  try {
    return run();
  } finally {
    globalThis.document = original;
  }
}

test('miner vault owns its components, a clear chest landing and batched masonry', () =>
  withCanvas(() => {
    const stage = MINER_VAULT.build(11);
    for (const name of [
      '01-fortress-and-portcullis',
      '02-receding-mine-tunnel',
      '03-cavern-rock-and-stalactites',
      '04-chest-dais-and-broken-ravine',
      '05-timber-galleries-and-railway',
      '06-minecarts-crates-and-tools',
      '07-miners-guild-banners',
      '08-molten-lava-cascade',
      '09-underground-waterfalls',
      '10-luminous-cyan-ore-veins',
      '11-ground-mist',
      '12-rising-embers',
    ]) {
      assert(stage.root.getObjectByName(name), name);
    }
    // The chest stands on the plinth's top, and the physics' ground is the drawn stone, not a floor.
    assert.deepEqual(stage.anchor, [0, 1.48, 0]);
    assert.equal(stage.ground.floor, undefined);
    const tops = stage.ground.boxes
      .filter((b) => Math.abs(b.center[0]) < 1 && Math.abs(b.center[2]) < 1)
      .map((b) => b.center[1] + b.half[1]);
    assert(
      tops.some((top) => Math.abs(top - stage.anchor[1]) < 1e-9),
      'a box of stone ends exactly under the chest',
    );
    assert(stage.light, "the chest is lit in the cavern's colours");
    assert(stage.camera.target[1] > stage.anchor[1], 'the camera aims at the chest');
    let meshes = 0,
      instances = 0;
    stage.root.traverse((o) => {
      if (o.isMesh) meshes++;
      if (o instanceof InstancedMesh) instances += o.count;
    });
    assert(meshes < 300, 'repeated blocks must be instanced');
    assert(instances > 30000);
    const crystals = stage.root.getObjectByName('cyan-ore-crystals');
    assert(crystals instanceof InstancedMesh);
    assert.equal(crystals.count, 110, 'all ore crystals survive in one draw instead of 110');
    assert(Number.isFinite(crystals.boundingSphere.radius));
    const bounds = new Box3().setFromObject(stage.root);
    assert(bounds.min.z < -80 && bounds.max.y > 30);
    assert.equal(stage.transparent, undefined);
  }));

test('miner atmosphere animates without a chest and preserves finite vertices', () =>
  withCanvas(() => {
    const stage = MINER_VAULT.build(11);
    for (const time of [0, 1, 24, 1000]) {
      for (const actor of stage.living)
        actor.update(
          { time, wind: 0, rand: Math.random, host: undefined, gust() {}, flash() {}, blast() {} },
          0.016,
        );
      stage.root.traverse((o) => {
        const position = o.geometry?.attributes.position;
        if (position) for (const value of position.array) assert(Number.isFinite(value));
      });
    }
  }));

test('production mine frames the actual floating GLB above the intro controls on desktop and mobile', async () => {
  const stage = withCanvas(() => MINER_VAULT.build(11));
  const raw = await readFile(new URL('../../public/' + ENDER_CASE.model.path, import.meta.url));
  const jsonLength = raw.readUInt32LE(12),
    gltf = JSON.parse(raw.subarray(20, 20 + jsonLength));
  // Keep the exported geometry and transforms; only browser bitmap decoding is irrelevant here.
  for (const mesh of gltf.meshes)
    for (const primitive of mesh.primitives) delete primitive.material;
  delete gltf.materials;
  delete gltf.images;
  delete gltf.textures;
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 32)]);
  const binary = raw.subarray(20 + jsonLength),
    header = Buffer.alloc(20);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length + binary.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.write('JSON', 16);
  const bytes = Buffer.concat([header, json, binary]);
  const { scene } = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    '',
  );
  scene.rotation.y = ENDER_CASE.model.rotationY;
  scene.updateMatrixWorld(true);
  const normalized = normalizeChestBounds(
    [ENDER_CASE.model.body, ENDER_CASE.model.lid].map((name) =>
      new Box3().setFromObject(scene.getObjectByName(name)),
    ),
  );
  const normalization = new Group();
  normalization.scale.setScalar(normalized.scale);
  normalization.position.copy(normalized.center).multiplyScalar(-normalized.scale);
  normalization.add(scene);
  const visual = new Group();
  visual.add(normalization);
  visual.position.copy(PREVIEW_POSE.position);
  const place = new Group();
  place.position.set(...stage.anchor);
  place.rotation.y = -Math.atan2(-5, -7);
  place.scale.setScalar(1 / (CHEST_WIDTH / 1.5));
  place.add(visual);
  place.updateMatrixWorld(true);
  const vertices = [];
  place.traverse((object) => {
    if (!object.isMesh) return;
    const attribute = object.geometry.attributes.position;
    for (let i = 0; i < attribute.count; i++)
      vertices.push(
        new Vector3().fromBufferAttribute(attribute, i).applyMatrix4(object.matrixWorld),
      );
  });
  for (const [width, height] of [
    [2006, 1248],
    [1600, 900],
    [390, 844],
  ])
    for (const time of [0, 30, 120, 240]) {
      const camera = new PerspectiveCamera(stage.camera.fov, width / height, 0.1, 1200);
      const [x, y, z] = stage.camera.position,
        drift = stage.camera.drift;
      camera.position.set(
        x + Math.sin(time * 0.05) * 2.2 * drift,
        y + Math.sin(time * 0.07) * 0.4 * drift,
        z + Math.cos(time * 0.04) * 1.2 * drift,
      );
      camera.lookAt(new Vector3(...stage.camera.target));
      const [fx, fy] = stage.camera.focus;
      camera.setViewOffset(width, height, (0.5 - fx) * width, (0.5 - fy) * height, width, height);
      camera.updateMatrixWorld();
      const bounds = new Box3().setFromPoints(vertices.map((p) => p.clone().project(camera)));
      const top = (1 - bounds.max.y) / 2,
        bottom = (1 - bounds.min.y) / 2;
      assert.ok(top > 0.08, 'model stays below the header');
      assert.ok(bottom < 0.48, 'model stays above the controls/catalog, with room for preview bob');
      assert.ok(
        bottom - top > 0.15 && bottom - top < 0.3,
        'hero chest occupies 15–30% of viewport height',
      );
      assert.ok(bounds.min.x > -1 && bounds.max.x < 1, 'portrait viewport does not crop the chest');
    }
});
