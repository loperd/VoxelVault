import {
  DirectionalLight,
  Group,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  PointLight,
  type Material,
} from 'three';
import { BlockRegistry } from '../blocks.ts';
import { BlockWorld } from '../world.ts';
import { computeLight, computeRigLight, type RigSource } from '../light.ts';
import { meshWorld } from '../mesher.ts';
import { raw } from '../color.ts';
import {
  flickerBeat,
  LIGHTING_PRESETS,
  LOCAL_BUDGET,
  resolveLighting,
  type Emitter,
  type LightingPreset,
  type LightingScene,
  type LocalLight,
  type StageLighting,
} from '../lighting.ts';
import {
  worldMeshes,
  type GuestLight,
  type Living,
  type Stage,
  type StageBuilder,
} from '../view.ts';
import { Owned, type PackAssets } from './assets.ts';
import type { Vec3, WorldPack } from './read.ts';

/**
 * A pack as a stage for one view: the app picks one of its cameras and, if it takes a guest, the
 * marker the guest stands on — the pack knows nothing of what the guest is. Never cached: every
 * view builds its own instance (its root, its world meshes, its clones of the models, its lights)
 * and frees it with `stage.dispose()`; the atlas and the models' geometries, materials and textures
 * stay with the PackAssets the instance borrowed them from.
 *
 * Its light is the pack's `environment`, or a lighting preset (the pack's default, or any given to
 * `relight`): the world meshes are made again with the preset's baked light and its sources, the
 * objects' lights and emissive copies of their glowing materials follow it, and its sky, fog, sun,
 * guest light and locals read it — all of this instance's own, so two views show two presets.
 */
export function packStage<H>(
  assets: PackAssets,
  choice: { readonly camera: string; readonly anchor?: string },
): StageBuilder<H> {
  const pack = assets.pack;
  const camera = pack.cameras.get(choice.camera);
  if (!camera)
    throw new Error(
      `The pack "${pack.id}" has no camera "${choice.camera}" (it has ${[...pack.cameras.keys()].join(', ') || 'none'}).`,
    );
  const marker = choice.anchor === undefined ? undefined : pack.markers.get(choice.anchor);
  if (choice.anchor !== undefined && !marker)
    throw new Error(
      `The pack "${pack.id}" has no marker "${choice.anchor}" (it has ${[...pack.markers.keys()].join(', ') || 'none'}).`,
    );
  return {
    id: `${pack.id}@${pack.version}#${pack.hash.slice(0, 8)}:${camera.name}:${marker?.name ?? ''}`,
    cache: false,
    build(): Stage<H> {
      if (assets.released)
        throw new Error(
          `The resources of the pack "${pack.id}" were released; load it again to show it.`,
        );
      const owned = new Owned();
      let blocks: Owned | undefined;
      try {
        const registry = new BlockRegistry(pack.blocks, { strict: true });
        const {
            size: [sx, sy, sz],
            origin,
          } = pack.structure,
          cells = pack.structure.cells();
        const world = new BlockWorld(sx, sy, sz, origin, {
          openSides: pack.structure.sides === 'open',
        });
        for (let z = 0, i = 0; z < sz; z++)
          for (let y = 0; y < sy; y++)
            for (let x = 0; x < sx; x++, i++) if (cells[i]) world.set(x, y, z, cells[i]!);
        computeLight(world, registry);

        const root = new Group();
        root.name = `pack:${pack.id}`;

        // The models: clones that share the template's geometry and materials (the template's, not ours),
        // in their own root: the view draws them in standard colour (Stage.objects).
        const objects = new Group();
        objects.name = `pack:${pack.id}:objects`;
        for (const object of pack.objects) {
          const clone = assets.template(object.model).clone(true);
          clone.position.set(...object.at);
          clone.rotation.set(
            ...(object.rotation.map(MathUtils.degToRad) as [number, number, number]),
            'YXZ',
          );
          clone.scale.set(...object.scale);
          objects.add(clone);
        }

        // The objects' light: a sky/ground fill and a key from a place towards the anchor (else the
        // middle). They light the objects' pass only; the blocks carry their light baked.
        const [ox, oy, oz] = origin,
          middle: Vec3 = [ox + sx / 2, oy + sy / 2, oz + sz / 2];
        const anchor = marker?.at;
        const fill = owned.add(new HemisphereLight());
        const key = owned.add(new DirectionalLight());
        objects.add(fill, key, key.target);
        /** Point lights for the objects (made with the first preset, then always LOCAL_BUDGET), copies of glowing materials. */
        const locals: PointLight[] = [],
          glowing: { material: MeshStandardMaterial; base: number }[] = [];

        const scene: LightingScene = {
          origin,
          markers: pack.markers,
          ...(anchor ? { anchor } : {}),
          focus: camera.look,
          eye: camera.eye,
          objects: pack.objects.map((object) => object.at),
          rig: pack.lighting?.rig ?? [],
          emitters: emitters(world, registry),
        };
        let lit: StageLighting = environmentLighting(pack, middle, anchor);
        let disposed = false;

        const show = (next: StageLighting) => {
          // The new meshes first: if meshing fails, the old light stays as it was.
          const made = new Owned();
          let parts;
          try {
            const rig = next.rig.length
              ? computeRigLight(
                  world,
                  registry,
                  next.rig.map((light) => rigSource(light, world)),
                )
              : undefined;
            parts = worldMeshes(
              meshWorld(world, registry, {
                uv: assets.atlas.uv,
                ...next.blocks,
                ...(rig ? { rig } : {}),
              }),
              assets.atlas.texture,
            );
            for (const part of parts) {
              made.add(part.geometry);
              made.add(part.material as Material);
            }
          } catch (error) {
            made.dispose();
            throw error;
          }
          for (const part of root.children.slice()) root.remove(part);
          blocks?.dispose();
          blocks = made;
          root.add(...parts);

          const o = next.objects,
            exposure = next.exposure ?? 1;
          fill.color.set(o.sky);
          fill.groundColor.set(o.ground);
          fill.intensity = o.fill;
          key.color.set(o.key);
          key.intensity = o.keyStrength;
          key.position.set(...o.keyAt);
          key.target.position.set(...o.target);
          if (next.locals && !locals.length) {
            for (let i = 0; i < LOCAL_BUDGET; i++)
              objects.add((locals[i] = owned.add(new PointLight(0xffffff, 0, 1, 2))));
            // Emissive materials are the template's: this instance glows through copies of its own.
            const own = (material: Material): Material => {
              if (!(material instanceof MeshStandardMaterial) || material.emissive.getHex() === 0)
                return material;
              const copy = owned.add(material.clone());
              glowing.push({ material: copy, base: material.emissiveIntensity });
              return copy;
            };
            objects.traverse((object) => {
              if (object instanceof Mesh)
                object.material = Array.isArray(object.material)
                  ? object.material.map(own)
                  : own(object.material);
            });
          }
          locals.forEach((light, i) => {
            const local = next.locals?.[i];
            light.userData.base = local?.objects ?? 0;
            light.userData.flicker = local?.flicker ?? 0;
            light.intensity = light.userData.base;
            if (local) {
              light.color.set(local.color);
              light.distance = local.range;
              light.position.set(...local.at);
            }
          });
          for (const g of glowing)
            g.material.emissiveIntensity = g.base * (next.emissive ?? 1) * exposure;
          lit = next;
        };
        const fallback = pack.lighting?.default;
        show(fallback ? resolveLighting(presetOf(pack, fallback), scene) : lit);
        // Torchlight breathes on the objects as on the blocks around them.
        const flicker: Living<H> = {
          update(context) {
            for (const light of locals)
              if (light.userData.flicker)
                light.intensity =
                  light.userData.base *
                  (1 +
                    light.userData.flicker *
                      flickerBeat(context.time, light.position.x, light.position.z));
          },
        };

        // Counted last: a build that failed above borrowed nothing.
        const giveBack = assets.borrow();
        return {
          root,
          objects,
          living: [flicker],
          get sky() {
            return lit.sky;
          },
          get fog() {
            return lit.fog;
          },
          camera: {
            position: camera.eye,
            target: camera.look,
            ...(camera.fov !== undefined ? { fov: camera.fov } : {}),
            ...(camera.drift !== undefined ? { drift: camera.drift } : {}),
            ...(camera.focus ? { focus: camera.focus } : {}),
          },
          ...(anchor
            ? {
                anchor,
                ground: {
                  blocks: { world, registry, around: [anchor[0], anchor[2]] as const, radius: 4 },
                },
              }
            : {}),
          ...(marker?.front ? { anchorFront: marker.front } : {}),
          get sun() {
            return lit.sun;
          },
          get flicker() {
            return lit.flicker;
          },
          get exposure() {
            return lit.exposure;
          },
          get light() {
            return lit.guest;
          },
          get locals() {
            return lit.locals;
          },
          get lighting() {
            return lit.name;
          },
          ...(pack.environment.calm !== undefined ? { calm: pack.environment.calm } : {}),
          relight(preset: LightingPreset | undefined) {
            if (disposed) throw new Error('The stage was disposed.');
            show(
              preset ? resolveLighting(preset, scene) : environmentLighting(pack, middle, anchor),
            );
          },
          dispose() {
            if (disposed) return;
            disposed = true;
            root.removeFromParent();
            objects.removeFromParent();
            blocks?.dispose();
            owned.dispose();
            giveBack();
          },
        };
      } catch (error) {
        blocks?.dispose();
        owned.dispose();
        throw error;
      }
    },
  };
}

/** A preset by name: the pack's own, else the library's. */
export function presetOf(pack: WorldPack, name: string): LightingPreset {
  const preset = pack.lighting?.presets.get(name) ?? LIGHTING_PRESETS[name];
  if (!preset)
    throw new Error(`No lighting preset "${name}" in the pack "${pack.id}" or the library.`);
  return preset;
}

/**
 * The pack's `environment` as it has always been shown: its tints and sun baked into the blocks, the
 * objects lit from its marker, the guest from the same place. No preset, no locals, no exposure.
 */
function environmentLighting(
  pack: WorldPack,
  middle: Vec3,
  anchor: Vec3 | undefined,
): StageLighting {
  const env = pack.environment,
    sun = env.sun,
    light = env.light;
  const {
    size: [, sy],
    origin: [, oy],
  } = pack.structure;
  const from = light.from ?? [middle[0], oy + sy * 2, middle[2]];
  // The guest's key comes from the same place, as a direction from where it stands.
  const guest: GuestLight = {
    sky: light.sky,
    ground: light.ground,
    key: light.key,
    ...(light.from && anchor
      ? {
          from: [
            light.from[0] - anchor[0],
            light.from[1] - anchor[1],
            light.from[2] - anchor[2],
          ] as const,
        }
      : {}),
    ...(light.guest ? { keyStrength: light.guest.key, fillStrength: light.guest.fill } : {}),
  };
  return {
    blocks: {
      ...env.blocks,
      ...(sun
        ? {
            sun: {
              direction: sun.direction,
              color: raw(sun.color).toArray() as [number, number, number],
              strength: sun.strength,
              ...(sun.reach ? { reach: sun.reach } : {}),
            },
          }
        : {}),
    },
    rig: [],
    sky: env.sky,
    fog: env.fog,
    ...(sun
      ? {
          sun: {
            direction: sun.direction,
            color: sun.color,
            ...(sun.scatter !== undefined ? { scatter: sun.scatter } : {}),
          },
        }
      : {}),
    ...(env.flicker !== undefined ? { flicker: env.flicker } : {}),
    objects: {
      sky: light.sky,
      ground: light.ground,
      fill: light.objects.fill,
      key: light.key,
      keyStrength: light.objects.key,
      keyAt: from,
      target: anchor ?? middle,
    },
    guest,
  };
}

/** Every glowing block, at its cell's middle. */
function emitters(world: BlockWorld, registry: BlockRegistry): Emitter[] {
  const found: Emitter[] = [],
    [ox, oy, oz] = world.origin;
  for (let z = 0; z < world.sz; z++)
    for (let y = 0; y < world.sy; y++)
      for (let x = 0; x < world.sx; x++) {
        const block = registry.get(world.get(x, y, z));
        if (block && block.light > 0)
          found.push({
            at: [ox + x + 0.5, oy + y + 0.5, oz + z + 0.5],
            level: block.light,
            second: block.secondLight,
          });
      }
  return found;
}

/** A local light for the blocks: the cell it is in, starting one level above its reach (a level lost per block). */
function rigSource(light: LocalLight, world: BlockWorld): RigSource {
  const [ox, oy, oz] = world.origin;
  return {
    cell: [
      Math.floor(light.at[0] - ox),
      Math.floor(light.at[1] - oy),
      Math.floor(light.at[2] - oz),
    ],
    level: Math.max(2, Math.min(15, Math.round(light.range) + 1)),
    color: raw(light.color).toArray() as [number, number, number],
    intensity: light.intensity,
    flicker: light.flicker,
  };
}
