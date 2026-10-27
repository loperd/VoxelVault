import {
  createChestAppearance,
  copyChestAppearance,
  resolveModifications,
  type ChestAppearance,
} from '../../../domain/chest-appearance.ts';
import { applyChestPalette, chestEffectColor } from './chest-appearance.ts';
import { ChestModificationLayers } from './chest-modification-layers.ts';
import { ENDER_CASE, type ChestModelDefinition } from '../../../config/cases.ts';
import {
  Box3,
  Group,
  Mesh,
  NearestFilter,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  type AnimationClip,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { waitFor } from '../../../application/cancellation.ts';
import { resolvePublicAsset } from '../data/asset-url.ts';
import { normalizeChestBounds } from './chest-bounds.ts';
import { disposeObject } from './dispose-object.ts';
import type { BoxCollider } from './physics-world-port.ts';

export interface ChestAssets {
  readonly appearance: ChestAppearance;
  readonly visual: Group;
  readonly colliders: readonly BoxCollider[];
  readonly animations: readonly AnimationClip[];
  readonly animationRoot: Group;
  readonly key?: Object3D;
  /** Static instance modifications; call update(delta) to animate glow pulses. */
  readonly modifications: ChestModificationLayers;
  restore(): void;
  dispose(): void;
}

/**
 * Chest models fetched ahead of time (the warm-up after sign-in), kept in memory for the session:
 * every scene gets its copy without a download, whatever the server's cache headers say.
 */
const modelBuffers = new Map<string, Promise<ArrayBuffer>>();

export function prefetchChestModel(url: string): Promise<void> {
  let pending = modelBuffers.get(url);
  if (!pending) {
    pending = fetch(url).then((response) => {
      if (!response.ok)
        throw new Error(`The chest model request failed with HTTP ${response.status}.`);
      return response.arrayBuffer();
    });
    // A failed prefetch is forgotten: the scene then simply downloads the model itself.
    pending.catch(() => {
      if (modelBuffers.get(url) === pending) modelBuffers.delete(url);
    });
    modelBuffers.set(url, pending);
  }
  return pending.then(() => undefined);
}

export async function loadChestAssets(
  baseUrl: URL,
  signal: AbortSignal,
  definition: ChestModelDefinition = ENDER_CASE.model,
  metadata: ChestAppearance = createChestAppearance(),
  effectColor = chestEffectColor(metadata),
): Promise<ChestAssets> {
  signal.throwIfAborted();
  const appearance = copyChestAppearance(metadata);
  const url = resolvePublicAsset(definition.path, baseUrl),
    prefetched = modelBuffers.get(url);
  let buffer: ArrayBuffer;
  if (prefetched) {
    // A copy: the Draco decoder may transfer the buffer to its worker.
    buffer = (await waitFor(prefetched, signal)).slice(0);
  } else {
    const response = await waitFor(fetch(url, { signal }), signal);
    if (!response.ok)
      throw new Error(`The chest model request failed with HTTP ${response.status}.`);
    buffer = await waitFor(response.arrayBuffer(), signal);
  }
  signal.throwIfAborted();

  const draco = new DRACOLoader()
    .setDecoderPath({
      js: resolvePublicAsset('vendor/draco/draco_wasm_wrapper.js', baseUrl),
      wasm: resolvePublicAsset('vendor/draco/draco_decoder.wasm', baseUrl),
    })
    .setWorkerLimit(1);
  const loader = new GLTFLoader().setDRACOLoader(draco);
  let model: Group | undefined;
  let modelDisposed = false;
  const disposeModel = () => {
    if (!model || modelDisposed) return;
    modelDisposed = true;
    disposeObject(model);
  };
  let claimed = false;
  try {
    const parsing = loader
      .parseAsync(buffer, resolvePublicAsset('models/', baseUrl))
      .then((gltf) => {
        model = gltf.scene;
        if (signal.aborted) {
          disposeModel();
          signal.throwIfAborted();
        }
        return gltf;
      });
    const gltf = await waitFor(parsing, signal);
    signal.throwIfAborted();
    // The imported Ender front faces +Z; our camera looks from -Z.
    gltf.scene.rotation.y = definition.rotationY;
    const body = gltf.scene.getObjectByName(definition.body);
    const roof = gltf.scene.getObjectByName(definition.lid);
    const key = definition.key ? gltf.scene.getObjectByName(definition.key) : undefined;
    if (!body || !roof) throw new Error('The configured body and lid nodes are missing.');
    applyChestPalette(gltf.scene, appearance, definition.modifications);
    for (const name of definition.openingClips) {
      const clip = gltf.animations.find((clip) => clip.name === name);
      if (!clip) throw new Error(`The model animation ${name} is missing.`);
      if (!Number.isFinite(clip.duration) || clip.duration <= 0)
        throw new Error(`The model animation ${name} has an invalid duration.`);
    }
    if (key) key.visible = false;
    const transforms: { object: Object3D; restore(): void }[] = [];
    gltf.scene.traverse((object) => {
      const position = object.position.clone(),
        rotation = object.quaternion.clone(),
        scale = object.scale.clone();
      transforms.push({
        object,
        restore() {
          object.position.copy(position);
          object.quaternion.copy(rotation);
          object.scale.copy(scale);
        },
      });
    });
    gltf.scene.updateMatrixWorld(true);
    const boxes = [body, roof].map((part) => {
      const box = new Box3().setFromObject(part);
      if (box.isEmpty()) throw new Error('A chest part has no geometry.');
      return {
        min: { x: box.min.x, y: box.min.y, z: box.min.z },
        max: { x: box.max.x, y: box.max.y, z: box.max.z },
      };
    });
    const normalized = normalizeChestBounds(boxes);
    const normalization = new Group();
    normalization.scale.setScalar(normalized.scale);
    normalization.position.set(
      -normalized.center.x * normalized.scale,
      -normalized.center.y * normalized.scale,
      -normalized.center.z * normalized.scale,
    );
    normalization.add(gltf.scene);
    const group = new Group();
    group.add(normalization);
    group.traverse((object) => {
      if (object instanceof Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (material instanceof MeshStandardMaterial && material.map) {
            // Crisp nearby pixels, mipmaps for oblique/distant faces to prevent moiré.
            material.map.magFilter = NearestFilter;
            material.map.minFilter = LinearMipmapLinearFilter;
            material.map.generateMipmaps = true;
            // Faces seen edge-on smear into stripes without anisotropic filtering (clamped to the GPU max).
            material.map.anisotropy = 16;
            material.map.needsUpdate = true;
          }
        }
      }
    });
    // After bounds and shadows: crystals must not enlarge colliders, overlays must not cast shadows.
    const modifications = new ChestModificationLayers(
      gltf.scene,
      definition.modifications,
      resolveModifications(appearance, definition.modifications),
      effectColor,
    );
    let disposed = false;
    const assets: ChestAssets = {
      appearance,
      visual: group,
      colliders: normalized.colliders,
      animations: Object.freeze(
        gltf.animations.filter((clip) => definition.openingClips.includes(clip.name)),
      ),
      animationRoot: gltf.scene,
      key,
      modifications,
      restore() {
        for (const transform of transforms) transform.restore();
        if (key) key.visible = false;
        group.scale.setScalar(1);
        group.visible = true;
        group.updateMatrixWorld(true);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        group.removeFromParent();
        modifications.dispose();
        disposeModel();
        group.clear();
      },
    };
    claimed = true;
    return assets;
  } finally {
    draco.dispose();
    if (!claimed) disposeModel();
  }
}
