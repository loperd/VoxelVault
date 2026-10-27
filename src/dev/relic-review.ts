/** Development-only review page. Does not activate or replace a production case. */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  AnimationMixer,
  Box3,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  LoopOnce,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PCFSoftShadowMap,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadChestAssets, type ChestAssets } from '../adapters/outbound/chest/chest-assets.ts';
import type { ChestModelDefinition } from '../config/cases.ts';

const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(900, 900);
renderer.setPixelRatio(1);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;
document.querySelector('#view')!.appendChild(renderer.domElement);
const scene = new Scene();
scene.background = new Color('#20252c');
const camera = new OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.01, 40);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.86, 0);
const floor = new Mesh(
  new PlaneGeometry(200, 200),
  new MeshStandardMaterial({ color: '#30353d', roughness: 0.9 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.025;
floor.receiveShadow = true;
scene.add(floor);
const lights = new Group();
scene.add(lights);
const pmrem = new PMREMGenerator(renderer);
const room = new RoomEnvironment();
const environment = pmrem.fromScene(room, 0.06);
room.dispose();
pmrem.dispose();
const clayMaterial = new MeshStandardMaterial({ color: '#969696', metalness: 0, roughness: 0.75 });
const originals = new Map<Mesh, Mesh['material']>();
const optimized =
  document.documentElement.dataset.optimized === 'true' ||
  new URLSearchParams(location.search).get('optimized') === '1';
let assets: ChestAssets | undefined,
  mixer: AnimationMixer | undefined,
  clay = false,
  opened = false;
let selected = 'v4',
  emissionEnabled = true;
const errors: string[] = [];
renderer.debug.onShaderError = (_gl, program, vertex, fragment) => {
  errors.push(
    `Shader compilation failed: ${String(program)} / ${String(vertex)} / ${String(fragment)}`,
  );
};

function setRig(mode: string) {
  lights.clear();
  scene.environment = mode === 'app' || clay ? null : environment.texture;
  scene.environmentIntensity = mode === 'showcase' ? 0.6 : 0.28;
  lights.add(new HemisphereLight(0xffffff, 0x444655, mode === 'app' ? 2 : 0.65));
  const setup =
    mode === 'showcase'
      ? [
          [-4, 4, -5, 6],
          [4, 2, -1, 2],
          [1, 4, 5, 4],
        ]
      : [
          [-4, 6, -5, mode === 'app' ? 3 : 3.5],
          [4, 3, -1, 0.9],
          [1, 5, 5, 2],
        ];
  for (const [x = 0, y = 0, z = 0, power = 1] of setup) {
    const light = new DirectionalLight(0xffffff, power);
    light.position.set(x, y, z);
    light.target.position.set(0, 0.8, 0);
    lights.add(light, light.target);
    if (x < 0) {
      light.castShadow = true;
      light.shadow.mapSize.set(2048, 2048);
      Object.assign(light.shadow.camera, {
        left: -2,
        right: 2,
        top: 3,
        bottom: -1,
        near: 0.1,
        far: 15,
      });
      light.shadow.bias = -0.0001;
      light.shadow.normalBias = 0.015;
    }
  }
  if (mode === 'app') {
    lights.clear();
    lights.add(new HemisphereLight(0xffffff, 0x435846, 2));
    const key = new DirectionalLight(0xffffff, 3);
    key.position.set(3, 6, -4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, {
      left: -5,
      right: 5,
      top: 5,
      bottom: -5,
      near: 0.1,
      far: 20,
    });
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    lights.add(key, key.target);
  }
  if (clay) {
    lights.add(new AmbientLight(0xffffff, 0.1));
  }
  if (mode === 'weak') {
    scene.environmentIntensity *= 0.04;
    lights.traverse((object) => {
      if (object instanceof DirectionalLight || object instanceof HemisphereLight)
        object.intensity *= 0.04;
    });
  }
  render();
}
function setEmission(enabled: boolean) {
  emissionEnabled = enabled;
  assets?.visual.traverse((object) => {
    if (object instanceof Mesh)
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material instanceof MeshStandardMaterial) material.emissiveIntensity = enabled ? 1 : 0;
      }
  });
  render();
  status();
}
function pose(direction: Vector3) {
  camera.position.copy(controls.target).add(direction.normalize().multiplyScalar(6));
  camera.lookAt(controls.target);
  controls.update();
  render();
}
function render() {
  renderer.render(scene, camera);
}
function status() {
  const material = new Map<string, object>();
  assets?.visual.traverse((object) => {
    if (object instanceof Mesh)
      for (const m of Array.isArray(object.material) ? object.material : [object.material])
        if (m instanceof MeshStandardMaterial)
          material.set(m.name, {
            name: m.name,
            base: !!m.map,
            roughness: !!m.roughnessMap,
            metallic: !!m.metalnessMap,
            normal: !!m.normalMap,
            ao: !!m.aoMap,
            emissive: !!m.emissiveMap,
            emissiveFactor: m.emissive.toArray(),
            emissiveIntensity: m.emissiveIntensity,
          });
  });
  const report = {
    ready: !!assets,
    asset: selected,
    optimized,
    renderer: renderer.info.render,
    materials: [...material.values()],
    errors,
    gpu: renderer.getContext().getParameter(renderer.getContext().VERSION) as string,
    clay,
    opened,
    emissionEnabled,
    exposure: renderer.toneMappingExposure,
  };
  Object.assign(window, { relicReviewStatus: report });
  document.querySelector('#status')!.textContent =
    `${selected} · ${report.gpu}\n${renderer.info.render.triangles} triangles · ${material.size} materials\n${errors.length ? errors.join('\n') : 'GLB загружен. Проверить видимые поверхности.'}`;
  return report;
}
async function load(which: string) {
  selected = which;
  assets?.dispose();
  assets = undefined;
  originals.clear();
  clay = opened = false;
  emissionEnabled = true;
  status();
  const folders: Record<string, string> = {
    before: 'relic-v3-geometry',
    after: 'relic-v3-pbr',
    v4: 'relic-v4',
  };
  const path = `assets/chests/${folders[which] ?? 'relic-v4'}${optimized ? '-runtime' : ''}/relic.glb`;
  const definition: ChestModelDefinition = {
    revision: 'relic-review',
    path,
    body: 'Body',
    lid: 'LidAssembly',
    openingClips: ['Vault.Open'],
    rotationY: 0,
    modifications: {
      schemaVersion: 1,
      revision: 'authored-pbr',
      parts: [
        { id: 'body', label: 'Body', nodes: ['Body'] },
        { id: 'lid', label: 'Lid', nodes: ['LidAssembly'] },
      ],
      colorZones: [],
      catalog: [],
    },
  };
  assets = await loadChestAssets(
    new URL('./', location.href),
    new AbortController().signal,
    definition,
  );
  const bounds = new Box3().setFromObject(assets.visual);
  assets.visual.position.y -= bounds.min.y;
  scene.add(assets.visual);
  mixer = new AnimationMixer(assets.animationRoot);
  setRig((document.querySelector('#rig') as HTMLSelectElement).value);
  render();
  status();
}
controls.addEventListener('change', render);
document.querySelector('#asset')!.addEventListener('change', (event) => {
  void load((event.target as HTMLSelectElement).value);
});
document.querySelector('#rig')!.addEventListener('change', (event) => {
  setRig((event.target as HTMLSelectElement).value);
  status();
});
document.querySelector('#emission')!.addEventListener('click', () => setEmission(!emissionEnabled));
document.querySelector('#clay')!.addEventListener('click', () => {
  clay = !clay;
  assets?.visual.traverse((object) => {
    if (object instanceof Mesh) {
      if (clay) {
        originals.set(object, object.material);
        object.material = clayMaterial;
      } else {
        object.material = originals.get(object)!;
      }
    }
  });
  setRig((document.querySelector('#rig') as HTMLSelectElement).value);
  status();
});
document.querySelector('#open')!.addEventListener('click', () => {
  opened = !opened;
  if (!assets || !mixer) return;
  const clip = assets.animations[0];
  if (!clip) return;
  const action = mixer.clipAction(clip);
  action.reset().setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.setTime(opened ? 1 : 0);
  render();
  status();
  const direction = camera.position.clone().sub(controls.target);
  const half = opened ? 2 : 1.6;
  camera.left = camera.bottom = -half;
  camera.right = camera.top = half;
  camera.updateProjectionMatrix();
  controls.target.y = opened ? 1.45 : 0.86;
  pose(direction);
});
document.querySelector('#front')!.addEventListener('click', () => pose(new Vector3(0, 0, -1)));
document.querySelector('#top')!.addEventListener('click', () => pose(new Vector3(0, 1, -0.00001)));
document
  .querySelector('#three')!
  .addEventListener('click', () => pose(new Vector3(1.5, 1.15, -1.9)));
document.querySelector('#save')!.addEventListener('click', () => {
  render();
  const link = document.createElement('a');
  link.download = `relic-${selected}-${clay ? 'clay' : 'pbr'}-${opened ? 'open' : 'closed'}.png`;
  link.href = renderer.domElement.toDataURL('image/png');
  link.click();
});
Object.assign(window, { relicReview: { status, load, render, setEmission } });
pose(new Vector3(1.5, 1.15, -1.9));
void load('v4').catch((error) => {
  errors.push(String(error));
  document.querySelector('#status')!.textContent = String(error);
});
