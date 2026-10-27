/** Core Three.js PBR on actual GLB patches. No replacement/custom material shader. */
import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RectAreaLight,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

type Family = 'obsidian' | 'metal' | 'crystal';
interface Study {
  family: Family;
  variant: string;
  asset: string;
  sha256: string;
  focusMaterial: number;
  camera: { direction: number[]; scale: number; target: number[] };
}
interface Slot {
  study: Study;
  scene: Scene;
  camera: OrthographicCamera;
  materials: MeshStandardMaterial[];
}
const size = 480,
  renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(size * 3, size * 3);
renderer.setPixelRatio(1);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.setScissorTest(true);
document.querySelector('main')!.appendChild(renderer.domElement);
RectAreaLightUniformsLib.init();
const slots: Slot[] = [],
  errors: string[] = [];
renderer.debug.onShaderError = () => {
  errors.push('WebGL shader compilation failed');
};
const defaults = new Map<
  MeshStandardMaterial,
  {
    normalX: number;
    normalY: number;
    metal: number;
    emission: number;
    roughness: number;
    roughnessMap: MeshStandardMaterial['roughnessMap'];
  }
>();
let ready = false;
const rigs = {
  neutral: [
    [-1.8, 0.2, -3.4, 2, 0.45, 6],
    [2.8, 2.4, -1.5, 2.5, 2.5, 10],
    [-0.5, 2.8, 2.8, 2, 2, 6],
  ],
  grazing: [
    [-3, 0.8, -1.6, 0.8, 1.7, 18],
    [2.8, 2.4, -1.5, 2.5, 2.5, 10],
    [-0.5, 2.8, 2.8, 2, 2, 6],
  ],
};
function rigName() {
  return (document.querySelector('#rig') as HTMLSelectElement).value;
}
function setRig() {
  for (const slot of slots) {
    const old = slot.scene.children.filter((child) => child.userData.studyLight);
    for (const light of old) {
      light.removeFromParent();
      if (light instanceof RectAreaLight || light instanceof DirectionalLight) light.dispose();
    }
    const rig = rigName();
    if (rig === 'app') {
      const sky = new HemisphereLight(0xffffff, 0x435846, 2),
        key = new DirectionalLight(0xffffff, 3);
      key.position.set(3, 6, -4);
      for (const light of [sky, key]) {
        light.userData.studyLight = true;
        slot.scene.add(light);
      }
    } else {
      for (const [x = 0, y = 0, z = 0, width = 1, height = 1, intensity = 1] of rigs[
        rig as keyof typeof rigs
      ]) {
        const light = new RectAreaLight(0xffffff, intensity, width, height);
        light.position.set(x, y, z);
        light.lookAt(0, 0.96, 0);
        light.userData.studyLight = true;
        slot.scene.add(light);
      }
      const sky = new HemisphereLight(0xffffff, 0x444444, 0.25);
      sky.userData.studyLight = true;
      slot.scene.add(sky);
    }
  }
  render();
}
function render() {
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    const x = (i % 3) * size,
      y = (2 - Math.floor(i / 3)) * size;
    renderer.setViewport(x, y, size, size);
    renderer.setScissor(x, y, size, size);
    renderer.render(slot.scene, slot.camera);
  }
}
function toggleChannels() {
  const normal = (document.querySelector('#normal') as HTMLInputElement).checked;
  const roughness = (document.querySelector('#roughness') as HTMLInputElement).checked;
  const metallic = (document.querySelector('#metallic') as HTMLInputElement).checked;
  const emissive = (document.querySelector('#emissive') as HTMLInputElement).checked;
  for (const slot of slots)
    for (const material of slot.materials) {
      const original = defaults.get(material)!;
      material.normalScale.set(normal ? original.normalX : 0, normal ? original.normalY : 0);
      const map = roughness ? original.roughnessMap : null;
      if (material.roughnessMap !== map) {
        material.roughnessMap = map;
        material.needsUpdate = true;
      }
      material.roughness = roughness ? original.roughness : 0.49;
      material.metalness = metallic ? original.metal : 0;
      material.emissiveIntensity = emissive ? original.emission : 0;
    }
  render();
}
function status() {
  return {
    ready,
    engine: 'Three.js WebGLRenderer / GLTFLoader / MeshStandardMaterial',
    rig: rigName(),
    errors,
    gpu: renderer.getContext().getParameter(renderer.getContext().VERSION) as string,
    textureCount: renderer.info.memory.textures,
    studies: slots.map((slot) => ({
      family: slot.study.family,
      variant: slot.study.variant,
      assetSha256: slot.study.sha256,
      materials: slot.materials.map((m) => ({
        name: m.name,
        base: !!m.map,
        normal: !!m.normalMap,
        metallic: !!m.metalnessMap,
        roughness: !!m.roughnessMap,
        ao: !!m.aoMap,
        emissive: !!m.emissiveMap,
      })),
    })),
  };
}
function pixels(family: Family) {
  render();
  const row = ['obsidian', 'metal', 'crystal'].indexOf(family);
  const context = renderer.getContext();
  const rgba = new Uint8Array(size * size * 4);
  context.readPixels(size, (2 - row) * size, size, size, context.RGBA, context.UNSIGNED_BYTE, rgba);
  const error = context.getError();
  if (error) throw new Error(`WebGL readPixels error ${error}`);
  return Array.from(rgba);
}
async function main() {
  const response = await fetch('/assets/chests/relic-material-lookdev/manifest.json');
  if (!response.ok) throw new Error('Study manifest not found');
  const manifest = (await response.json()) as { studies: Study[] };
  const loader = new GLTFLoader();
  for (const study of manifest.studies) {
    const gltf = await loader.loadAsync(`/${study.asset}`),
      scene = new Scene();
    scene.background = new Color('#30363e');
    scene.add(gltf.scene);
    const floor = new Mesh(
      new PlaneGeometry(40, 40),
      new MeshStandardMaterial({ color: '#30353d', roughness: 0.88 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.015;
    scene.add(floor);
    const h = study.camera.scale / 2,
      camera = new OrthographicCamera(-h, h, h, -h, 0.01, 30),
      target = new Vector3(...study.camera.target);
    camera.position
      .copy(target)
      .add(new Vector3(...study.camera.direction).normalize().multiplyScalar(4));
    camera.lookAt(target);
    const materials = new Set<MeshStandardMaterial>();
    gltf.scene.traverse((object) => {
      if (object instanceof Mesh)
        for (const material of Array.isArray(object.material) ? object.material : [object.material])
          if (material instanceof MeshStandardMaterial) materials.add(material);
    });
    for (const material of materials)
      defaults.set(material, {
        normalX: material.normalScale.x,
        normalY: material.normalScale.y,
        metal: material.metalness,
        emission: material.emissiveIntensity,
        roughness: material.roughness,
        roughnessMap: material.roughnessMap,
      });
    slots.push({ study, scene, camera, materials: [...materials] });
  }
  setRig();
  ready = true;
  document.querySelector('#status')!.textContent =
    `WebGL · ${slots.length} GLB · строки: обсидиан / металл / кристалл. Переключатели отключают реальные каналы материала.`;
}
for (const id of ['normal', 'roughness', 'metallic', 'emissive'])
  document.querySelector(`#${id}`)!.addEventListener('change', toggleChannels);
document.querySelector('#rig')!.addEventListener('change', setRig);
Object.assign(window, { materialStudy: { status, pixels, render } });
void main().catch((error) => {
  errors.push(String(error));
  document.querySelector('#status')!.textContent = String(error);
});
