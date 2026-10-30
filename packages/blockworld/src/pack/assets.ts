import { Mesh, Texture, type Material, type Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { packAtlas, TILE } from '../atlas.ts';
import { decodePng } from './png.ts';
import type { Pbr } from '../view.ts';
import type { WorldPack } from './read.ts';

/**
 * A pack's loaded resources: its own atlas and a template of every model (with their geometries,
 * materials and textures). Shared by any number of stages, which only borrow them: a stage clones a
 * template's objects, never changes its geometry or materials, and copies a material it must change.
 * Whoever loaded it releases it, after the last stage is gone. No cache anywhere: loading the same
 * pack twice gives two independent sets; after `release` it is shown again only by a new load.
 */
export interface PackAssets {
  readonly pack: WorldPack;
  readonly atlas: {
    readonly texture: Texture;
    uv(name: string): [number, number, number, number];
    /** Normal and MER maps laid out like `texture`, when the pack has `<tile>_n` / `<tile>_s` tiles. */
    readonly pbr?: Pbr;
  };
  /** A model's template, as loaded; an unknown name throws. Never to be changed or added to a scene. */
  template(name: string): Object3D;
  /** Stages built on these resources and not yet disposed. */
  readonly instances: number;
  readonly released: boolean;
  /**
   * A stage takes the resources for itself: counted until the returned give-back is called (once;
   * again does nothing). Throws after `release`.
   */
  borrow(): () => void;
  /** Frees everything; throws while stages still use it, does nothing the second time. */
  release(): void;
}

/**
 * Live counts, for tests and a dev page's leak check — not a cache, it holds nothing: how many
 * PackAssets are not released, and how many GPU-side resources (textures, geometries, materials)
 * loaders and stages made and have not freed yet.
 */
export const packDiagnostics = { assets: 0, resources: 0 };

/** Things to free, freed once, in any order of failure. */
export class Owned {
  private readonly items: { dispose(): void }[] = [];
  private done = false;
  add<T extends { dispose(): void }>(item: T): T {
    if (this.done) {
      item.dispose();
      throw new Error('Freed already.');
    }
    this.items.push(item);
    packDiagnostics.resources++;
    return item;
  }
  /** Every geometry, material and texture of an object tree. */
  addTree(root: Object3D): void {
    const seen = new Set<{ dispose(): void }>();
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      seen.add(object.geometry);
      for (const material of ([] as Material[]).concat(object.material)) {
        seen.add(material);
        for (const value of Object.values(material)) if (value instanceof Texture) seen.add(value);
      }
    });
    for (const item of seen) this.add(item instanceof Texture ? textureWithImage(item) : item);
  }
  dispose(): void {
    if (this.done) return;
    this.done = true;
    for (const item of this.items.splice(0)) {
      item.dispose();
      packDiagnostics.resources--;
    }
  }
}

/** A texture whose image (an ImageBitmap from the loader) is closed with it. */
function textureWithImage(texture: Texture): { dispose(): void } {
  return {
    dispose: () => {
      const image = texture.image as { close?: () => void } | undefined;
      texture.dispose();
      image?.close?.();
    },
  };
}

const aborted = (signal: AbortSignal) => signal.reason ?? new DOMException('Aborted', 'AbortError');

/**
 * Loads a checked pack: decodes its tiles into its own atlas and parses its models. All or nothing:
 * on any failure, and on `signal` — even if it comes after the last step — everything made is freed
 * and the promise rejects (with the signal's reason when cancelled).
 */
export async function loadPackAssets(
  pack: WorldPack,
  options: { signal: AbortSignal },
): Promise<PackAssets> {
  const { signal } = options,
    owned = new Owned();
  try {
    if (signal.aborted) throw aborted(signal);
    const tiles = await Promise.all(
      pack.textureNames.map(async (name) => {
        try {
          return { name, rgba: (await decodePng(pack.texture(name), { size: TILE, signal })).rgba };
        } catch (error) {
          if (signal.aborted) throw aborted(signal);
          throw new Error(
            `Texture "${name}": ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }),
    );
    if (signal.aborted) throw aborted(signal);
    // PBR companions ride in `textures` like any tile: `<name>_n` (normal) and `<name>_s` (MER:
    // metalness, emissive, roughness). They go to parallel atlases with the same layout, so the
    // shader reads them at the block tile's own UV.
    const isMap = ({ name }: { name: string }) => /_[ns]$/.test(name);
    const base = tiles.filter((tile) => !isMap(tile));
    const atlas = packAtlas(base);
    owned.add(atlas);
    const flat = { n: [128, 128, 255, 255], s: [0, 0, 255, 255] } as const; // up; dull, unlit
    const companion = (kind: 'n' | 's') => {
      const given = new Map(tiles.map((tile) => [tile.name, tile.rgba]));
      const tilesOf = base.map(({ name }) => ({
        name,
        rgba:
          given.get(`${name}_${kind}`) ??
          Uint8Array.from({ length: TILE * TILE * 4 }, (_, i) => flat[kind][i % 4]!),
      }));
      return owned.add(packAtlas(tilesOf));
    };
    const pbr = tiles.some(isMap)
      ? { normal: companion('n').texture, material: companion('s').texture }
      : undefined;

    // Every model parses even if one fails, so that all that was made is owned and freed.
    const loader = new GLTFLoader();
    const parsed = await Promise.allSettled(
      pack.modelNames.map(
        (name) =>
          new Promise<[string, Object3D]>((resolve, reject) => {
            loader.parse(
              pack.model(name),
              '',
              (gltf) => {
                // Every scene the loader built is owned (a checked model has one: it is gltf.scene).
                for (const scene of gltf.scenes) owned.addTree(scene);
                resolve([name, gltf.scene]);
              },
              (error) =>
                reject(
                  new Error(
                    `Model "${name}": ${error instanceof Error ? error.message : String(error)}`,
                    { cause: error },
                  ),
                ),
            );
          }),
      ),
    );
    const failed = parsed.find((result) => result.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
    if (signal.aborted) throw aborted(signal);
    const templates = new Map(
      parsed.map((result) => (result as PromiseFulfilledResult<[string, Object3D]>).value),
    );

    let instances = 0,
      released = false;
    packDiagnostics.assets++;
    return {
      pack,
      atlas: { texture: atlas.texture, uv: atlas.uv, ...(pbr ? { pbr } : {}) },
      template(name) {
        const template = templates.get(name);
        if (!template) throw new Error(`The pack "${pack.id}" has no model "${name}".`);
        return template;
      },
      get instances() {
        return instances;
      },
      get released() {
        return released;
      },
      borrow() {
        if (released)
          throw new Error(
            `The resources of the pack "${pack.id}" were released; load it again to show it.`,
          );
        instances++;
        let given = false;
        return () => {
          if (!given) {
            given = true;
            instances--;
          }
        };
      },
      release() {
        if (released) return;
        if (instances > 0)
          throw new Error(
            `The resources of the pack "${pack.id}" are still used by ${instances} stage(s); dispose their views first.`,
          );
        released = true;
        packDiagnostics.assets--;
        owned.dispose();
      },
    };
  } catch (error) {
    owned.dispose();
    throw error;
  }
}
