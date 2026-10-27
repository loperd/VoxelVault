import {
  AdditiveBlending,
  AnimationMixer,
  Box3,
  DirectionalLight,
  Euler,
  Group,
  HemisphereLight,
  LoopOnce,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  ShaderMaterial,
  Sphere,
  Vector3,
  type AnimationAction,
  type Material,
  type Texture,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { waitFor } from '../../../application/cancellation.ts';
import type { ItemState } from '../../../domain/case-instance.ts';
import {
  ITEM_VISUALS,
  type ItemLight,
  type ItemVisual,
  type ModelRef,
} from '../../../config/item-visuals.ts';
import { resolvePublicAsset } from '../data/asset-url.ts';

/** Parsed models for the page's lifetime: small (tens of KB), shared by every stage as clones. */
const models = new Map<string, Promise<GLTF>>();

function loadModel(baseUrl: URL, ref: ModelRef, signal: AbortSignal): Promise<GLTF> {
  const url = `${resolvePublicAsset(ref.path, baseUrl)}?v=${ref.revision}`;
  let pending = models.get(url);
  if (!pending) {
    // Not tied to one caller's signal: another stage may be waiting for the same model.
    pending = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
    pending.catch(() => {
      if (models.get(url) === pending) models.delete(url);
    });
    models.set(url, pending);
  }
  return waitFor(pending, signal);
}

const LIGHTS: Readonly<
  Record<
    ItemLight,
    {
      readonly sky: string;
      readonly ground: string;
      readonly key: string;
      readonly rim: string;
      readonly exposure: number;
    }
  >
> = {
  studio: { sky: '#f4f1ea', ground: '#3a4250', key: '#fff3dc', rim: '#9fd8ff', exposure: 1.05 },
  void: { sky: '#d9c8ff', ground: '#1c1030', key: '#f3e8ff', rim: '#b46bff', exposure: 1 },
  hall: { sky: '#ffe7c4', ground: '#3b2b22', key: '#ffd9a0', rim: '#7fb8ff', exposure: 1 },
};

/** Damage darkens and dulls the model; the server's condition, shown, never decided here. */
const WEAR: Readonly<Record<ItemState, { readonly tint: number; readonly roughness: number }>> = {
  intact: { tint: 1, roughness: 0 },
  slight: { tint: 0.82, roughness: 0.15 },
  heavy: { tint: 0.62, roughness: 0.3 },
  broken: { tint: 0.45, roughness: 0.45 },
};

/** Minecraft's glint: violet bands sliding across the model in object space, added over its colour. */
function glintMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { time: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexShader:
      'varying vec3 vSpot; void main() { vSpot = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: `uniform float time; varying vec3 vSpot;
void main() { float band = fract((vSpot.x + vSpot.y * .6 - vSpot.z * .3) * 1.6 - time * .35);
  float glow = smoothstep(.0, .12, band) * smoothstep(.34, .12, band);
  gl_FragColor = vec4(vec3(.55, .32, 1.) * glow * .55, 1.); }`,
  });
}

export interface ItemStage {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** The model's bounds at rest: what the camera frames and orbits. */
  readonly bounds: Sphere;
  readonly exposure: number;
  /** Advance animations, the glow pulse and the glint by `dt` seconds. */
  update(dt: number): void;
  /** Sets the camera for `aspect` at the visual's first view. */
  frame(aspect: number): void;
  dispose(): void;
}

/** Everything one view of one item needs. `environment` gives metal something to reflect (owned by the caller's renderer). */
export async function createItemStage(
  baseUrl: URL,
  itemId: string,
  signal: AbortSignal,
  options: { readonly condition?: ItemState; readonly environment?: Texture } = {},
): Promise<ItemStage> {
  const visual = ITEM_VISUALS[itemId];
  if (!visual) throw new Error(`The item ${itemId} has no model.`);
  const owned: Material[] = [],
    glints: ShaderMaterial[] = [],
    glows: { material: MeshStandardMaterial; base: number }[] = [];
  const wear = WEAR[options.condition ?? 'intact'];

  /** A private copy of a model: geometry shared with the cache, materials its own (glow, damage). */
  const instance = async (target: ItemVisual): Promise<Group> => {
    const root = new Group(),
      gltf = await loadModel(baseUrl, target.model, signal);
    root.add(gltf.scene.clone(true));
    for (const ref of target.wear ?? []) {
      const outfit = await loadModel(baseUrl, ref, signal);
      for (const piece of outfit.scene.children)
        root.getObjectByName(piece.name)?.add(piece.clone(true));
    }
    const meshes: Mesh[] = [];
    // Before held items join: each held item has dressed its own materials.
    root.traverse((object) => {
      if (object instanceof Mesh) meshes.push(object);
    });
    for (const mesh of meshes) {
      const material = (mesh.material as MeshStandardMaterial).clone();
      material.color.multiplyScalar(wear.tint);
      material.roughness = Math.min(1, material.roughness + wear.roughness);
      material.envMapIntensity = 0.6;
      if (material.name === 'glow') {
        material.emissiveIntensity *= wear.tint;
        glows.push({ material, base: material.emissiveIntensity });
      }
      mesh.material = material;
      owned.push(material);
      if (target.enchanted) {
        const glint = glintMaterial(),
          overlay = new Mesh(mesh.geometry, glint);
        overlay.userData.glint = true;
        mesh.add(overlay);
        glints.push(glint);
        owned.push(glint);
      }
    }
    for (const held of target.hold ?? []) {
      const heldVisual = ITEM_VISUALS[held.item],
        hand = root.getObjectByName(held.at);
      if (!heldVisual || !hand)
        throw new Error(
          `The item ${itemId} holds ${held.item} at ${held.at}, which does not exist.`,
        );
      const item = await instance(heldVisual);
      item.scale.setScalar(held.scale);
      item.rotation.copy(
        new Euler(
          ...(held.turn.map((degrees) => (degrees * Math.PI) / 180) as [number, number, number]),
        ),
      );
      if (held.offset) item.position.set(...held.offset);
      hand.add(item);
    }
    return root;
  };

  const model = await instance(visual);
  signal.throwIfAborted();
  const scene = new Scene(),
    light = LIGHTS[visual.light];
  if (options.environment) scene.environment = options.environment;
  const key = new DirectionalLight(light.key, 1.9);
  key.position.set(-2, 3, 3);
  const rim = new DirectionalLight(light.rim, 1.5);
  rim.position.set(2.5, 1.5, -3);
  scene.add(new HemisphereLight(light.sky, light.ground, 0.8), key, rim, model);

  const mixer = new AnimationMixer(model);
  const clips = (await loadModel(baseUrl, visual.model, signal)).animations;
  const clip = (name?: string) =>
    name ? clips.find((candidate) => candidate.name === name) : undefined;
  const idle = clip(visual.idle),
    gesture = clip(visual.inspect);
  let idling: AnimationAction | undefined;
  if (idle) {
    idling = mixer.clipAction(idle);
    idling.play();
  }
  if (gesture) {
    const action = mixer.clipAction(gesture);
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = false;
    idling?.setEffectiveWeight(0);
    action.play();
    mixer.addEventListener('finished', () => idling?.setEffectiveWeight(1));
  }

  // Bounds over every pose the clips reach, so the framing never jumps nor cuts a raised arm.
  const box = new Box3().setFromObject(model, true),
    rest: [Object3D, Vector3, Quaternion, Vector3][] = [];
  model.traverse((object) =>
    rest.push([object, object.position.clone(), object.quaternion.clone(), object.scale.clone()]),
  );
  for (const probe of [idle, gesture]) {
    if (!probe) continue;
    const poser = new AnimationMixer(model);
    poser.clipAction(probe).play();
    for (let step = 1; step <= 16; step++) {
      poser.setTime((probe.duration * step) / 16);
      box.union(new Box3().setFromObject(model, true));
    }
    poser.stopAllAction();
    poser.uncacheRoot(model);
  }
  for (const [object, position, quaternion, scale] of rest) {
    object.position.copy(position);
    object.quaternion.copy(quaternion);
    object.scale.copy(scale);
  }
  const bounds = box.getBoundingSphere(new Sphere());
  const camera = new PerspectiveCamera(30, 1, 0.01, 50);
  let time = 0;
  return {
    scene,
    camera,
    bounds,
    exposure: light.exposure,
    update(dt) {
      time += dt;
      mixer.update(dt);
      for (const glow of glows)
        glow.material.emissiveIntensity = glow.base * (0.8 + 0.3 * Math.sin(time * 2.4));
      for (const glint of glints) glint.uniforms.time!.value = time;
    },
    frame(aspect) {
      camera.aspect = aspect;
      // Fit the bounding sphere into the narrower field of view, with a little air around it.
      const vertical = (camera.fov * Math.PI) / 360,
        horizontal = Math.atan(Math.tan(vertical) * aspect);
      const distance = (bounds.radius / Math.sin(Math.min(vertical, horizontal))) * 1.04;
      const around = (visual.view.azimuth * Math.PI) / 180,
        above = (visual.view.elevation * Math.PI) / 180;
      camera.position
        .copy(bounds.center)
        .add(
          new Vector3(
            Math.sin(around) * Math.cos(above),
            Math.sin(above),
            Math.cos(around) * Math.cos(above),
          ).multiplyScalar(distance),
        );
      camera.near = distance / 20;
      camera.far = distance * 4;
      camera.lookAt(bounds.center);
      camera.updateProjectionMatrix();
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      for (const material of owned) material.dispose();
      scene.clear();
    },
  };
}
