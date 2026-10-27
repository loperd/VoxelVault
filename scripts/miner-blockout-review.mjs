/** Analytical review only. Does not produce or substitute for a WebGL screenshot. */
import { mkdir, writeFile } from 'node:fs/promises';
import { Box3, InstancedMesh, PerspectiveCamera, Vector3 } from 'three';
import { MINER_BLOCKOUT } from '../src/adapters/outbound/worlds/miner/blockout.ts';

const directory = new URL('../artifacts/miner-vault/', import.meta.url);
await mkdir(directory, { recursive: true });
const builds = [];
for (let i = 0; i < 30; i++) {
  const started = performance.now();
  const s = MINER_BLOCKOUT.build(11);
  builds.push(performance.now() - started);
  if (i < 29) {
    const geometry = new Set(),
      material = new Set();
    s.root.traverse((o) => {
      if (o.isMesh) {
        geometry.add(o.geometry);
        material.add(o.material);
        o.dispose?.();
      }
    });
    for (const g of geometry) g.dispose();
    for (const m of material) m.dispose();
  }
}
const stage = MINER_BLOCKOUT.build(11);
stage.root.updateMatrixWorld(true);
const camera = new PerspectiveCamera(stage.camera.fov, 1536 / 960, 0.1, 1200);
camera.position.set(...stage.camera.position);
camera.lookAt(new Vector3(...stage.camera.target));
camera.updateMatrixWorld();
const project = ([x, y, z]) => {
  const p = new Vector3(x, y, z).project(camera);
  return [Math.round((p.x + 1) * 768), Math.round((1 - p.y) * 480)];
};
const groups = stage.root.children
  .filter((o) => o.isGroup)
  .map((o) => {
    const b = new Box3().setFromObject(o);
    return { name: o.name, worldBounds: [b.min.toArray(), b.max.toArray()] };
  });
const landmarks = {
  fortressCrown: project([0, 27, -25]),
  bridgeCenter: project([0, 0, -9.5]),
  portalCenter: project([0, 5, -19]),
  leftLavaHead: project([-22, -2, -4]),
  tunnelVanishingArea: project([0, 5, -130]),
};
let instances = 0,
  batches = 0;
stage.root.traverse((o) => {
  if (o instanceof InstancedMesh) {
    instances += o.count;
    batches++;
  }
});
builds.sort((a, b) => a - b);
await writeFile(
  new URL('blockout-projection.json', directory),
  JSON.stringify(
    {
      viewport: [1536, 960],
      camera: stage.camera,
      landmarks,
      groups,
      warning:
        'Analytical projection; no occlusion, material or lighting validation. Not a screenshot.',
    },
    null,
    2,
  ),
);
await writeFile(
  new URL('blockout-performance.json', directory),
  JSON.stringify(
    {
      samples: builds.length,
      buildCpuMs: { p50: builds[15], p95: builds[28] },
      structuralInstances: instances,
      instancedBatches: batches,
      baseTriangles: instances * 12,
      gpuFrameMs: null,
      fps: null,
      warning:
        'Node CPU construction benchmark only. Browser GPU/FPS measurements blocked by browser tool permissions.',
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ landmarks, instances, batches, cpuP50: builds[15], cpuP95: builds[28] }),
);
