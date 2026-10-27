/**
 * Lighting presets: one scene, many lights. A preset says what the light looks like in artistic terms
 * — the sky, the sun or moon, the glow of the world's lamps, local sources, fog, exposure — and
 * `resolveLighting` turns it into what each of the three passes needs:
 * - blocks: the mesher's baked light (sky, sun with its shadows, block light, local sources flooded
 *   through the grid as block light is) and the shaders' flicker and exposure;
 * - objects (GLB): a hemisphere fill, a directional key and up to `LOCAL_BUDGET` point lights;
 * - guests: the same colours and directions as a `GuestLight`, the same point lights in their pass.
 * Every field changes the picture; there is nothing to set that does nothing. This module is the
 * contract (types, the library, reading JSON) with no three.js, so a pack is read and checked in
 * Node; lighting.ts resolves a preset for the passes.
 */
export type Vec3 = readonly [number, number, number];

/** Kinds of local source; each has its own default colour, strength, reach and flicker. */
export const LOCAL_TYPES = ['torch', 'lantern', 'fire', 'lava', 'custom'] as const;
export type LocalType = (typeof LOCAL_TYPES)[number];

/**
 * Where a source is: coordinates in the pack's own frame (as pack.json places objects and markers:
 * the structure's corner at 0), a marker's name, or "@anchor" (where the guest stands).
 */
export type Place = Vec3 | string;

/**
 * Which frame a source lives in.
 * - "world" (the default): a light of the place. `at` and `offset` are world coordinates (the pack's
 *   axes); no camera moves it. Torches, lanterns, fire and lava are always world lights.
 * - "shot": art direction of one shot, a light placed for the camera. Only `type: "custom"` at
 *   "@anchor"; its `offset` is in the camera's frame (see `offset`).
 */
export const SOURCE_KINDS = ['world', 'shot'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** A local light as scene data: a world pack's rig, or a preset's own (an accent, say). */
export interface LightSource {
  readonly id?: string;
  /** "world" when absent. */
  readonly kind?: SourceKind;
  readonly type: LocalType;
  readonly at: Place;
  /**
   * Added to `at`, in blocks. A world light: along the pack's axes (a light above a marker or the
   * guest). A shot light: in the camera's frame at the guest, level — x to the camera's right, y up,
   * z towards the camera.
   */
  readonly offset?: Vec3;
  /** Defaults: the preset's style for the type, else the type's own (`SOURCE_TYPES`). */
  readonly color?: string;
  /** 1 is a torch. */
  readonly intensity?: number;
  /** How far it reaches, in blocks (1..14). */
  readonly range?: number;
  /** How much it flickers: the amplitude of its brightness, 0 steady .. .5. */
  readonly flicker?: number;
}

/** How a preset shows sources of one type: their colour (unless a source has its own), a multiplier of their strength, their flicker. */
export interface SourceStyle {
  readonly color?: string;
  readonly intensity?: number;
  readonly flicker?: number;
}

export interface LightingPreset {
  readonly name: string;
  readonly label: string;
  /** The sky dome, as seen: zenith, horizon, below. */
  readonly sky: { readonly top: string; readonly horizon: string; readonly bottom: string };
  /** Light from the open sky: on blocks where sky light reaches, and from above on objects and guests. */
  readonly skyLight: { readonly color: string; readonly intensity: number };
  /** The darkest anything gets (blocks), its colour also the fill from below; `occlusion` the blocks' corner darkening, 0..1. */
  readonly ambient: { readonly color: string; readonly level: number; readonly occlusion: number };
  /** The sun — or the moon: one directional light, baked with its shadows into blocks; null for none. */
  readonly sun: {
    readonly direction: Vec3;
    readonly color: string;
    readonly intensity: number;
    readonly reach?: number;
  } | null;
  /** The structure's own glowing blocks: the colour of their light (and of `secondLight` blocks), its strength and flicker. */
  readonly blockLight: {
    readonly color: string;
    readonly second: string;
    readonly intensity: number;
    readonly flicker: number;
  };
  /** How bright glowing things look themselves (glowing blocks, emissive model materials): 1 as made. */
  readonly emissive: number;
  readonly sources: Readonly<Partial<Record<LocalType, SourceStyle>>>;
  /** Sources this preset adds to the scene's rig. */
  readonly lights: readonly LightSource[];
  /**
   * The main light on objects and guests: from the sun, from the strongest local source near the
   * guest ("local"), or from a place. Its colour defaults to that light's.
   * A "local" key is art direction, not that source's light: on objects and guests it is a
   * directional light from the source's place towards the guest, as strong as `strength` wherever
   * they stand (no fall-off, no reach), and the source is no point light there besides. On blocks the
   * same source stays a world light: its intensity, its reach, stopped by walls.
   */
  readonly key: {
    readonly from: 'sun' | 'local' | { readonly at: Place; readonly offset?: Vec3 };
    readonly color?: string;
    readonly strength: number;
  };
  /** How strong the sky/ambient fill is on objects and guests. */
  readonly fill: number;
  /** `glow`: how much the haze shines towards the sun. */
  readonly fog: {
    readonly color: string;
    readonly near: number;
    readonly far: number;
    readonly glow: number;
  };
  /** One multiplier of all light on surfaces (blocks, objects, guests); sky and fog are as written. */
  readonly exposure: number;
}

export const SOURCE_TYPES: Readonly<
  Record<
    LocalType,
    {
      readonly color: string;
      readonly intensity: number;
      readonly range: number;
      readonly flicker: number;
    }
  >
> = {
  torch: { color: '#ffb35c', intensity: 1, range: 12, flicker: 0.09 },
  lantern: { color: '#ffd08a', intensity: 1, range: 13, flicker: 0.03 },
  fire: { color: '#ff8a3a', intensity: 1.2, range: 14, flicker: 0.14 },
  lava: { color: '#ff6a1a', intensity: 1, range: 14, flicker: 0.02 },
  custom: { color: '#ffffff', intensity: 1, range: 10, flicker: 0 },
};

/** At most this many point lights per pass (objects, guests): the rest light the blocks only. */
export const LOCAL_BUDGET = 4;

// ---------------------------------------------------------------------------------------------
// The library.

export const LIGHTING_PRESETS: Readonly<Record<string, LightingPreset>> = {
  'warm-torchlit': {
    name: 'warm-torchlit',
    label: 'Warm Torchlit',
    sky: { top: '#0d0a12', horizon: '#2e1d16', bottom: '#0a0706' },
    skyLight: { color: '#6c6078', intensity: 0.2 },
    ambient: { color: '#5a3a2a', level: 0.05, occlusion: 0.85 },
    sun: null,
    // Warm, not orange: a saturated tint darkens what is not itself warm (the ender chest went black).
    blockLight: { color: '#ffa258', second: '#7fd6ff', intensity: 1.5, flicker: 0.09 },
    emissive: 1.2,
    sources: { torch: { intensity: 1.2 }, lantern: { intensity: 1.15 }, fire: { intensity: 1.5 } },
    // Lantern-like light in front of the guest, to the left as the camera sees it: a pool on it and the floor, falling off, in any shot.
    lights: [
      {
        id: 'subject',
        kind: 'shot',
        type: 'custom',
        at: '@anchor',
        offset: [-1.3, 1.4, 2],
        color: '#ffc58a',
        intensity: 0.92,
        range: 6,
        flicker: 0.03,
      },
    ],
    key: { from: 'local', color: '#ffc488', strength: 2.2 },
    fill: 0.7,
    fog: { color: '#1a110c', near: 16, far: 60, glow: 0 },
    exposure: 1.05,
  },
  'cold-moonlight': {
    name: 'cold-moonlight',
    label: 'Cold Moonlight',
    sky: { top: '#050a18', horizon: '#1b2944', bottom: '#04060b' },
    skyLight: { color: '#8aa4d8', intensity: 0.55 },
    // Less saturated than the moon: the darkest places stay blue without going black.
    ambient: { color: '#4c5e8c', level: 0.07, occlusion: 0.85 },
    sun: { direction: [0.62, 0.62, 0.48], color: '#a9c6ff', intensity: 0.55, reach: 64 },
    blockLight: { color: '#ffae6a', second: '#8ad8ff', intensity: 0.85, flicker: 0.05 },
    emissive: 0.8,
    sources: {
      torch: { intensity: 0.7 },
      lantern: { intensity: 0.75 },
      fire: { intensity: 0.7 },
      lava: { intensity: 0.6 },
    },
    // Moonlight from above and in front of the guest: what the moon gives where the sky does not reach (a roofed room).
    lights: [
      {
        id: 'moonbeam',
        kind: 'shot',
        type: 'custom',
        at: '@anchor',
        offset: [1, 3.4, 1.6],
        color: '#9fb8ff',
        intensity: 1,
        range: 7,
        flicker: 0,
      },
    ],
    key: { from: 'sun', color: '#b4c8ff', strength: 1.8 },
    fill: 1,
    fog: { color: '#0d1525', near: 18, far: 64, glow: 0.4 },
    exposure: 0.95,
  },
  'golden-hour': {
    name: 'golden-hour',
    label: 'Golden Hour',
    sky: { top: '#3d5d8c', horizon: '#ffb46a', bottom: '#3b2a1e' },
    skyLight: { color: '#c9c2dc', intensity: 0.6 },
    ambient: { color: '#6e4b3a', level: 0.09, occlusion: 0.7 },
    // Low: long shadows, raking light.
    sun: { direction: [-0.86, 0.24, 0.45], color: '#ffa040', intensity: 0.72, reach: 64 },
    blockLight: { color: '#ffc080', second: '#8ad8ff', intensity: 0.85, flicker: 0.05 },
    emissive: 0.9,
    sources: { torch: { intensity: 0.5 }, lantern: { intensity: 0.5 }, fire: { intensity: 0.55 } },
    // Warm light thrown back in front of the guest, low: the evening's bounce where the sun itself does not come in.
    lights: [
      {
        id: 'bounce',
        kind: 'shot',
        type: 'custom',
        at: '@anchor',
        offset: [-1.4, 1, 2.2],
        color: '#ffb37a',
        intensity: 0.8,
        range: 7,
        flicker: 0,
      },
    ],
    key: { from: 'sun', color: '#ffb466', strength: 2.2 },
    fill: 0.8,
    fog: { color: '#c08a62', near: 26, far: 90, glow: 1.2 },
    exposure: 1.05,
  },
  'dark-cinematic': {
    name: 'dark-cinematic',
    label: 'Dark Cinematic',
    sky: { top: '#020203', horizon: '#0a0807', bottom: '#020202' },
    skyLight: { color: '#4a5262', intensity: 0.1 },
    ambient: { color: '#221b18', level: 0.025, occlusion: 0.85 },
    sun: null,
    blockLight: { color: '#ff9a52', second: '#6fc8ff', intensity: 0.5, flicker: 0.06 },
    emissive: 1.3,
    sources: { torch: { intensity: 0.45 }, lantern: { intensity: 0.45 }, fire: { intensity: 0.5 } },
    // A cold accent over the guest, in front: it stands apart from the warm, dim surroundings (art direction, variant C).
    lights: [
      {
        id: 'accent',
        kind: 'shot',
        type: 'custom',
        at: '@anchor',
        offset: [0.8, 2.6, 2.4],
        color: '#cfe0ff',
        intensity: 2.2,
        range: 5,
        flicker: 0,
      },
    ],
    key: { from: 'local', color: '#d8e6ff', strength: 2.4 },
    fill: 0.4,
    fog: { color: '#050404', near: 10, far: 40, glow: 0 },
    exposure: 1,
  },
};

// ---------------------------------------------------------------------------------------------
// Reading presets from JSON.

export interface LightingProblem {
  readonly path: string;
  readonly message: string;
}

export class LightingError extends Error {
  readonly problems: readonly LightingProblem[];
  constructor(problems: readonly LightingProblem[]) {
    super(`Lighting preset: ${problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`);
    this.name = 'LightingError';
    this.problems = problems;
  }
}

type Json = unknown;
type Obj = Record<string, Json>;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const isObject = (v: Json): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A preset from JSON: complete, or `{ "base": "<name>", ...changes }` over a library (or pack)
 * preset — objects merge key by key, anything else (lists, numbers, `"sun": null`) replaces. Throws
 * LightingError with every problem.
 */
export function readLightingPreset(
  json: Json,
  presets: (name: string) => LightingPreset | undefined = (name) => LIGHTING_PRESETS[name],
): LightingPreset {
  const problems: LightingProblem[] = [];
  let value = json;
  if (isObject(json) && json.base !== undefined) {
    const base = typeof json.base === 'string' ? presets(json.base) : undefined;
    if (!base)
      throw new LightingError([{ path: 'base', message: `no preset "${String(json.base)}"` }]);
    const { base: _, ...changes } = json;
    value = merge(base, changes);
  }
  const preset = checkPreset(value, '', problems);
  if (problems.length || !preset) throw new LightingError(problems);
  return preset;
}

/**
 * `changes` over `base`: objects merge, anything else replaces. Only own keys are read and every key
 * is written as an own one, so "__proto__" is a key like any other (and unknown to the checks), never
 * the result's prototype. It recurses only where `base` has an object, so no deeper than the base.
 */
export function merge(base: Json, changes: Json): Json {
  if (!isObject(base) || !isObject(changes)) return changes === undefined ? base : changes;
  const out: Obj = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    Object.defineProperty(out, key, {
      value: merge(Object.hasOwn(base, key) ? base[key] : undefined, value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** Problems of a list of sources (a pack's rig), each `at` a marker of `markers` if a name. */
export function checkSources(
  value: Json,
  path: string,
  problems: LightingProblem[],
  markers?: ReadonlySet<string>,
): LightSource[] {
  if (!Array.isArray(value)) {
    problems.push({ path, message: 'expected a list of light sources' });
    return [];
  }
  if (value.length > 64) problems.push({ path, message: 'more than 64 sources' });
  return value
    .map((source, i) => checkSource(source, `${path}[${i}]`, problems, markers))
    .filter((s): s is LightSource => s !== undefined);
}

function checkPreset(
  value: Json,
  at: string,
  problems: LightingProblem[],
): LightingPreset | undefined {
  const c = checker(problems, at),
    before = problems.length;
  const o = c.object(
    value,
    '',
    [
      'name',
      'label',
      'sky',
      'skyLight',
      'ambient',
      'sun',
      'blockLight',
      'emissive',
      'sources',
      'lights',
      'key',
      'fill',
      'fog',
      'exposure',
    ],
    ['label', 'sources', 'lights'],
  );
  if (!o) return undefined;
  const name = c.string(o.name, 'name', NAME),
    label = o.label === undefined ? name : c.string(o.label, 'label');
  const sky = c.object(o.sky, 'sky', ['top', 'horizon', 'bottom']);
  const skyLight = c.object(o.skyLight, 'skyLight', ['color', 'intensity']);
  const ambient = c.object(o.ambient, 'ambient', ['color', 'level', 'occlusion']);
  const blockLight = c.object(o.blockLight, 'blockLight', [
    'color',
    'second',
    'intensity',
    'flicker',
  ]);
  const key = c.object(o.key, 'key', ['from', 'color', 'strength'], ['color']);
  const fog = c.object(o.fog, 'fog', ['color', 'near', 'far', 'glow']);
  let sun: LightingPreset['sun'] = null;
  if (o.sun !== null) {
    const s = c.object(o.sun, 'sun', ['direction', 'color', 'intensity', 'reach'], ['reach']);
    const direction = s && c.tuple(s.direction, 'sun.direction');
    if (direction && direction[1]! <= 0)
      c.problem('sun.direction', 'the sun must be above the horizon (y > 0)');
    sun =
      s && direction
        ? {
            direction: direction as unknown as Vec3,
            color: c.color(s.color, 'sun.color'),
            intensity: c.number(s.intensity, 'sun.intensity', 0, 1),
            ...(s.reach !== undefined ? { reach: c.number(s.reach, 'sun.reach', 1, 256) } : {}),
          }
        : null;
  }
  const sources: Partial<Record<LocalType, SourceStyle>> = {};
  if (o.sources !== undefined) {
    const s = c.object(o.sources, 'sources', LOCAL_TYPES, LOCAL_TYPES);
    for (const type of LOCAL_TYPES) {
      if (!s || s[type] === undefined) continue;
      const style = c.object(
        s[type],
        `sources.${type}`,
        ['color', 'intensity', 'flicker'],
        ['color', 'intensity', 'flicker'],
      );
      if (style)
        sources[type] = {
          ...(style.color !== undefined
            ? { color: c.color(style.color, `sources.${type}.color`) }
            : {}),
          ...(style.intensity !== undefined
            ? { intensity: c.number(style.intensity, `sources.${type}.intensity`, 0, 4) }
            : {}),
          ...(style.flicker !== undefined
            ? { flicker: c.number(style.flicker, `sources.${type}.flicker`, 0, 0.5) }
            : {}),
        };
    }
  }
  const lights = o.lights === undefined ? [] : checkSources(o.lights, `${at}lights`, problems);
  let from: LightingPreset['key']['from'] = 'sun';
  if (key) {
    if (key.from === 'sun' || key.from === 'local') from = key.from;
    else if (isObject(key.from)) {
      const f = c.object(key.from, 'key.from', ['at', 'offset'], ['offset']);
      const place = f && checkPlace(f.at, `${at}key.from.at`, problems);
      if (f && place !== undefined)
        from = {
          at: place,
          ...(f.offset !== undefined
            ? { offset: c.tuple(f.offset, 'key.from.offset') as unknown as Vec3 }
            : {}),
        };
    } else c.problem('key.from', 'expected "sun", "local" or { "at": … }');
    if (from === 'sun' && o.sun === null)
      c.problem('key.from', 'the key is from the sun, but there is no sun');
  }
  if (fog && typeof fog.near === 'number' && typeof fog.far === 'number' && fog.far <= fog.near)
    c.problem('fog', '"far" must be past "near"');
  if (!sky || !skyLight || !ambient || !blockLight || !key || !fog) return undefined;
  const preset: LightingPreset = {
    name: name!,
    label: label!,
    sky: {
      top: c.color(sky.top, 'sky.top'),
      horizon: c.color(sky.horizon, 'sky.horizon'),
      bottom: c.color(sky.bottom, 'sky.bottom'),
    },
    skyLight: {
      color: c.color(skyLight.color, 'skyLight.color'),
      intensity: c.number(skyLight.intensity, 'skyLight.intensity', 0, 2),
    },
    ambient: {
      color: c.color(ambient.color, 'ambient.color'),
      level: c.number(ambient.level, 'ambient.level', 0, 1),
      occlusion: c.number(ambient.occlusion, 'ambient.occlusion', 0, 1),
    },
    sun,
    blockLight: {
      color: c.color(blockLight.color, 'blockLight.color'),
      second: c.color(blockLight.second, 'blockLight.second'),
      intensity: c.number(blockLight.intensity, 'blockLight.intensity', 0, 2),
      flicker: c.number(blockLight.flicker, 'blockLight.flicker', 0, 0.5),
    },
    emissive: c.number(o.emissive, 'emissive', 0, 4),
    sources,
    lights,
    key: {
      from,
      ...(key.color !== undefined ? { color: c.color(key.color, 'key.color') } : {}),
      strength: c.number(key.strength, 'key.strength', 0, 10),
    },
    fill: c.number(o.fill, 'fill', 0, 10),
    fog: {
      color: c.color(fog.color, 'fog.color'),
      near: c.number(fog.near, 'fog.near', 0, 2000),
      far: c.number(fog.far, 'fog.far', 0, 2000),
      glow: c.number(fog.glow, 'fog.glow', 0, 2),
    },
    exposure: c.number(o.exposure, 'exposure', 0.1, 4),
  };
  return problems.length === before ? preset : undefined;
}

function checkSource(
  value: Json,
  path: string,
  problems: LightingProblem[],
  markers?: ReadonlySet<string>,
): LightSource | undefined {
  const c = checker(problems, path);
  const o = c.object(
    value,
    '',
    ['id', 'kind', 'type', 'at', 'offset', 'color', 'intensity', 'range', 'flicker'],
    ['id', 'kind', 'offset', 'color', 'intensity', 'range', 'flicker'],
  );
  if (!o) return undefined;
  const before = problems.length;
  const type = LOCAL_TYPES.includes(o.type as LocalType)
    ? (o.type as LocalType)
    : c.problem('.type', `expected one of ${LOCAL_TYPES.join(', ')}`);
  const at = checkPlace(o.at, `${path}.at`, problems, markers);
  const kind =
    o.kind === undefined || SOURCE_KINDS.includes(o.kind as SourceKind)
      ? (o.kind as SourceKind | undefined)
      : c.problem('.kind', `expected one of ${SOURCE_KINDS.join(', ')}`);
  if (kind === 'shot') {
    if (at !== undefined && at !== '@anchor')
      c.problem('.at', 'a shot light is placed from the guest: "@anchor"');
    if (type !== undefined && type !== 'custom')
      c.problem(
        '.type',
        `a ${type} is a light of the world, never of the shot: "kind": "world", or "type": "custom"`,
      );
  }
  const source = {
    type: type!,
    at: at!,
    ...(o.id !== undefined ? { id: c.string(o.id, '.id', NAME) } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(o.offset !== undefined ? { offset: c.tuple(o.offset, '.offset') as unknown as Vec3 } : {}),
    ...(o.color !== undefined ? { color: c.color(o.color, '.color') } : {}),
    ...(o.intensity !== undefined ? { intensity: c.number(o.intensity, '.intensity', 0, 4) } : {}),
    ...(o.range !== undefined ? { range: c.number(o.range, '.range', 1, 14) } : {}),
    ...(o.flicker !== undefined ? { flicker: c.number(o.flicker, '.flicker', 0, 0.5) } : {}),
  };
  return problems.length === before ? source : undefined;
}

function checkPlace(
  value: Json,
  path: string,
  problems: LightingProblem[],
  markers?: ReadonlySet<string>,
): Place | undefined {
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v))
  )
    return value as unknown as Vec3;
  if (value === '@anchor') return value;
  if (typeof value === 'string' && NAME.test(value)) {
    if (markers && !markers.has(value)) {
      problems.push({ path, message: `no marker "${value}" in pack.markers` });
      return undefined;
    }
    return value;
  }
  problems.push({ path, message: 'expected [x, y, z], a marker\'s name or "@anchor"' });
  return undefined;
}

/** Small checks that record a problem at `base` + path and return a value of the right type regardless (only used when there were none). */
function checker(problems: LightingProblem[], base: string) {
  const join = (path: string) =>
    !base
      ? path.replace(/^\./, '')
      : path.startsWith('.') || !path
        ? `${base}${path}`
        : `${base}.${path}`;
  const problem = (path: string, message: string): undefined => {
    problems.push({ path: join(path) || '(preset)', message });
    return undefined;
  };
  return {
    problem,
    object(
      value: Json,
      path: string,
      keys: readonly string[],
      optional: readonly string[] = [],
    ): Obj | undefined {
      if (!isObject(value)) return problem(path, 'expected an object');
      for (const key of Object.keys(value))
        if (!keys.includes(key))
          problem(path ? `${path}.${key}` : key, 'unknown key (it would change nothing)');
      for (const key of keys)
        if (value[key] === undefined && !optional.includes(key))
          problem(path ? `${path}.${key}` : key, 'missing');
      return value;
    },
    string(value: Json, path: string, pattern?: RegExp): string {
      if (typeof value !== 'string' || (pattern && !pattern.test(value)))
        problem(
          path,
          pattern ? 'expected a name (letters, digits, "_", "-")' : 'expected a string',
        );
      return value as string;
    },
    color(value: Json, path: string): string {
      if (typeof value !== 'string' || !COLOR.test(value))
        problem(path, 'expected a colour "#rrggbb"');
      return value as string;
    },
    number(value: Json, path: string, min: number, max: number): number {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
        problem(path, `expected a number in ${min}..${max}`);
      return value as number;
    },
    tuple(value: Json, path: string): number[] | undefined {
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        !value.every((v) => typeof v === 'number' && Number.isFinite(v))
      )
        return problem(path, 'expected [x, y, z]');
      return value as number[];
    },
  };
}
