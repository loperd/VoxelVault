import type { MeshOptions } from './mesher.ts';
import type { GuestLight } from './view.ts';
import { raw } from './color.ts';
import {
  LOCAL_BUDGET,
  SOURCE_TYPES,
  type LightingPreset,
  type LightSource,
  type Place,
  type Vec3,
} from './lighting-preset.ts';

export * from './lighting-preset.ts';

/** Objects are lit in the world's pass, guests in their own look (ACES, exposure): the same light in each one's units. */
const OBJECT_GAIN = { key: 1, fill: 1, local: 6 };
const GUEST_GAIN = { key: 2.5, fill: 1.8, local: 15 };

// ---------------------------------------------------------------------------------------------
// From a preset to the passes.

/** A glowing block of the structure, in scene coordinates (its cell's middle). */
export interface Emitter {
  readonly at: Vec3;
  readonly level: number;
  readonly second: boolean;
}

/** What a preset is resolved against: one stage's places and light sources. */
export interface LightingScene {
  /** Where the pack's frame (its structure's corner) is in scene coordinates. */
  readonly origin: Vec3;
  readonly markers: ReadonlyMap<string, { readonly at: Vec3 }>;
  /** Where the guest stands, if the stage takes one. */
  readonly anchor?: Vec3;
  /** What the camera looks at: the place that matters when there is no anchor. */
  readonly focus: Vec3;
  /** Where the camera is: a local key is chosen on the camera's side of the guest, so the side we see is lit. */
  readonly eye?: Vec3;
  /** Where the objects (GLB) stand: a source near one of them lights it, even far from the guest. */
  readonly objects?: readonly Vec3[];
  /** The world pack's rig. */
  readonly rig: readonly LightSource[];
  readonly emitters: readonly Emitter[];
}

/** A local light resolved: scene position, colour, artistic strength, reach in blocks, flicker amplitude. */
export interface LocalLight {
  readonly at: Vec3;
  readonly color: string;
  readonly intensity: number;
  readonly range: number;
  readonly flicker: number;
}

/** A preset in the renderer's terms, for one stage. */
export interface StageLighting {
  /** The preset's; none for a stage's own light. */
  readonly name?: string;
  /** For meshWorld (without `uv` and `rig`). */
  readonly blocks: Omit<MeshOptions, 'uv' | 'rig'>;
  /** Sources flooded into the blocks' light (pack rig and preset lights). */
  readonly rig: readonly LocalLight[];
  readonly sky: { readonly top: string; readonly horizon: string; readonly bottom: string };
  readonly fog: { readonly color: string; readonly near: number; readonly far: number };
  readonly sun?: { readonly direction: Vec3; readonly color: string; readonly scatter?: number };
  /** The shaders' flicker uniform: the mesher's glow attribute holds amplitudes, so 1 for a preset. */
  readonly flicker?: number;
  readonly exposure?: number;
  readonly emissive?: number;
  readonly objects: {
    readonly sky: string;
    readonly ground: string;
    readonly fill: number;
    readonly key: string;
    readonly keyStrength: number;
    readonly keyAt: Vec3;
    readonly target: Vec3;
  };
  readonly guest: GuestLight;
  /** Point lights for objects and guests, the strongest at the anchor or an object first, at most LOCAL_BUDGET. Intensities in each pass's units. */
  readonly locals?: readonly {
    readonly at: Vec3;
    readonly color: string;
    readonly objects: number;
    readonly guest: number;
    readonly range: number;
    readonly flicker: number;
  }[];
}

const add = (a: Vec3, b: Vec3 = [0, 0, 0]): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const tint = (hex: string, k: number): [number, number, number] =>
  raw(hex)
    .toArray()
    .map((v) => Math.min(2, v * k)) as [number, number, number];
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** A place in the world, its offset along the world's axes: no camera moves it. */
export function resolvePlace(place: Place, offset: Vec3 | undefined, scene: LightingScene): Vec3 {
  if (Array.isArray(place)) return add(add(scene.origin, place as Vec3), offset);
  if (place === '@anchor') return add(scene.anchor ?? scene.focus, offset);
  const marker = scene.markers.get(place as string);
  if (!marker)
    throw new Error(
      `No marker "${String(place)}" for a light (there are ${[...scene.markers.keys()].join(', ') || 'none'}).`,
    );
  return add(marker.at, offset);
}

/**
 * A shot light's offset from the guest in the camera's frame — x to its right, y up, z towards it
 * (level) — as scene coordinates: a light "in front, to the left" is so from whichever side the
 * stage is seen.
 */
function facing(offset: Vec3, at: Vec3, eye: Vec3 | undefined): Vec3 {
  const dx = eye ? eye[0] - at[0] : 0,
    dz = eye ? eye[2] - at[2] : 0,
    length = Math.hypot(dx, dz);
  if (length < 1e-6) return offset;
  const toward = [dx / length, dz / length] as const,
    [x, y, z] = offset;
  // Right is up × towards: (towards.z, 0, -towards.x).
  return [x * toward[1] + z * toward[0], y, -x * toward[0] + z * toward[1]];
}

/** A source as this preset shows it: a world light where it is, a shot light where the camera has it. */
export function styledSource(
  source: LightSource,
  preset: LightingPreset,
  scene: LightingScene,
): LocalLight {
  const type = SOURCE_TYPES[source.type],
    style = preset.sources[source.type] ?? {};
  let at: Vec3;
  if (source.kind === 'shot') {
    const anchor = scene.anchor ?? scene.focus;
    at = add(anchor, source.offset && facing(source.offset, anchor, scene.eye));
  } else at = resolvePlace(source.at, source.offset, scene);
  return {
    at,
    color: source.color ?? style.color ?? type.color,
    intensity: (source.intensity ?? type.intensity) * (style.intensity ?? 1),
    range: source.range ?? type.range,
    flicker: style.flicker ?? source.flicker ?? type.flicker,
  };
}

/** How much a light gives at a point: strength falling off to nothing at its reach. */
function reaching(light: LocalLight, at: Vec3): number {
  const d = Math.hypot(light.at[0] - at[0], light.at[1] - at[1], light.at[2] - at[2]);
  return d >= light.range ? 0 : light.intensity * (1 - d / light.range) ** 2;
}

/**
 * The structure's glowing blocks as local lights for objects and guests: one per 3-block cell of
 * space (the brightest), so a fire of many blocks is one light, not dozens.
 */
function emitterLights(emitters: readonly Emitter[], preset: LightingPreset): LocalLight[] {
  const best = new Map<string, Emitter>();
  for (const e of emitters) {
    const key = e.at.map((v) => Math.floor(v / 3)).join(',');
    const was = best.get(key);
    if (!was || e.level > was.level) best.set(key, e);
  }
  return [...best.values()].map((e) => ({
    at: e.at,
    color: e.second ? preset.blockLight.second : preset.blockLight.color,
    intensity: (preset.blockLight.intensity * e.level) / 15,
    range: Math.max(1, e.level - 1),
    flicker: preset.blockLight.flicker,
  }));
}

export function resolveLighting(preset: LightingPreset, scene: LightingScene): StageLighting {
  const rig = [...scene.rig, ...preset.lights].map((source) => styledSource(source, preset, scene));
  const focus = scene.anchor ?? scene.focus;
  // Point lights for what reaches the guest or an object: a torch by a model lights the model too.
  const targets = [focus, ...(scene.objects ?? [])];
  const candidates = [...rig, ...emitterLights(scene.emitters, preset)]
    .map((light) => ({
      light,
      focus: reaching(light, focus),
      score: Math.max(...targets.map((at) => reaching(light, at))),
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  // The key among those that reach the guest: what lights the side the camera sees, not its back.
  const toEye =
    scene.eye && unit([scene.eye[0] - focus[0], scene.eye[1] - focus[1], scene.eye[2] - focus[2]]);
  const facing = (light: LocalLight) => {
    if (!toEye) return 1;
    const d = unit([light.at[0] - focus[0], light.at[1] - focus[1], light.at[2] - focus[2]]);
    return 0.2 + 0.8 * Math.max(0, d[0] * toEye[0] + d[1] * toEye[1] + d[2] * toEye[2]);
  };
  const keyCandidate = candidates
    .filter((c) => c.focus > 0)
    .map((c) => ({ ...c, score: c.focus * facing(c.light) }))
    .sort((a, b) => b.score - a.score)[0];
  const sun = preset.sun;

  // The key: a direction (from the sun) or a place (a source, a marker).
  let keyAt: Vec3 | undefined,
    keyColor = preset.key.color,
    keyLight: LocalLight | undefined;
  const from = preset.key.from;
  if (from === 'sun' && sun) {
    const d = unit(sun.direction);
    keyAt = add(focus, [d[0] * 40, d[1] * 40, d[2] * 40]);
    keyColor ??= sun.color;
  } else if (from === 'local') {
    keyLight = keyCandidate?.light;
    keyAt = keyLight?.at;
    keyColor ??= keyLight?.color;
  } else if (typeof from === 'object') keyAt = resolvePlace(from.at, from.offset, scene);
  // No such light (no local source reaches the guest): from above, in the sky's colour.
  keyAt ??= add(focus, [0, 12, 4]);
  keyColor ??= preset.skyLight.color;
  const locals = candidates
    .filter((c) => c.light !== keyLight)
    .slice(0, LOCAL_BUDGET)
    .map(({ light }) => ({
      at: light.at,
      color: light.color,
      range: light.range,
      flicker: light.flicker,
      objects: light.intensity * OBJECT_GAIN.local * preset.exposure,
      guest: light.intensity * GUEST_GAIN.local,
    }));

  const ambient = raw(preset.ambient.color).toArray(),
    peak = Math.max(...ambient) || 1;
  return {
    name: preset.name,
    blocks: {
      sky: tint(preset.skyLight.color, preset.skyLight.intensity),
      glow: tint(preset.blockLight.color, preset.blockLight.intensity),
      glow2: tint(preset.blockLight.second, preset.blockLight.intensity),
      minimum: preset.ambient.level,
      shadow: ambient.map((v) => v / peak) as [number, number, number],
      occlusion: preset.ambient.occlusion,
      flicker: preset.blockLight.flicker,
      emissive: preset.emissive,
      ...(sun
        ? {
            sun: {
              direction: sun.direction,
              color: raw(sun.color).toArray() as [number, number, number],
              strength: sun.intensity,
              ...(sun.reach ? { reach: sun.reach } : {}),
            },
          }
        : {}),
    },
    rig,
    sky: preset.sky,
    fog: { color: preset.fog.color, near: preset.fog.near, far: preset.fog.far },
    ...(sun
      ? { sun: { direction: sun.direction, color: sun.color, scatter: preset.fog.glow } }
      : {}),
    flicker: 1,
    exposure: preset.exposure,
    emissive: preset.emissive,
    objects: {
      sky: preset.skyLight.color,
      ground: preset.ambient.color,
      fill: preset.fill * OBJECT_GAIN.fill * preset.exposure,
      key: keyColor,
      keyStrength: preset.key.strength * OBJECT_GAIN.key * preset.exposure,
      keyAt,
      target: focus,
    },
    guest: {
      sky: preset.skyLight.color,
      ground: preset.ambient.color,
      key: keyColor,
      ...(scene.anchor
        ? {
            from: [
              keyAt[0] - scene.anchor[0],
              keyAt[1] - scene.anchor[1],
              keyAt[2] - scene.anchor[2],
            ] as const,
          }
        : {}),
      keyStrength: preset.key.strength * GUEST_GAIN.key,
      fillStrength: preset.fill * GUEST_GAIN.fill,
    },
    locals,
  };
}

/**
 * The beat torchlight breathes to at a point, -1..1 — the blocks' shader computes the same from a
 * fragment's position, so a point light flickers with the blocks around it.
 */
export function flickerBeat(time: number, x: number, z: number): number {
  return (
    Math.sin(time * 7.3 + Math.floor(x * 0.25) * 1.9 + Math.floor(z * 0.25) * 2.7) * 0.6 +
    Math.sin(time * 13.1 + x) * 0.4
  );
}
