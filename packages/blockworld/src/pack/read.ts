import type {
  BlockDefinition,
  BlockModel,
  BlockPart,
  BlockSide,
  BlockTextures,
  PartFace,
} from '../blocks.ts';
import {
  checkSources,
  LIGHTING_PRESETS,
  LightingError,
  readLightingPreset,
  type LightingPreset,
  type LightSource,
} from '../lighting-preset.ts';

/**
 * A world pack: a world as data — its blocks and their PNG tiles, a grid of cells, GLB models
 * placed as objects, named markers and cameras, its sky, fog and light — with no code of its own and
 * no knowledge of who shows it. `readWorldPack` reads and checks one, in Node or a browser, with no
 * three.js and no GPU; what it returns is frozen and owns its bytes (`loadPackAssets` turns it into
 * textures and models, `packStage` into a stage for one view).
 *
 * Format 1 (docs/worlds/packs.md): `pack.json` and the files it names, nothing else.
 */

/** The pack format this engine reads. `pack.json` says `format` (and `requires.blockworld`) 1. */
export const PACK_FORMAT = 1;

/** Reads one file of a pack by its path inside the pack. Where the bytes come from is the caller's. */
export type PackFiles = (path: string, signal: AbortSignal) => Promise<ArrayBuffer>;

/**
 * Loader limits of format 1 — preliminary, for the first packs, not limits of the engine: a caller
 * may pass others. Triangles of a model count every node that uses a mesh; a pack's triangles and
 * nodes count every object placed (a model placed 40 times counts 40 times).
 */
export interface PackLimits {
  readonly packBytes: number;
  readonly manifestBytes: number;
  readonly pngBytes: number;
  readonly tile: number;
  readonly textures: number;
  readonly blocks: number;
  readonly size: readonly [number, number, number];
  readonly models: number;
  readonly objects: number;
  readonly markers: number;
  readonly cameras: number;
  readonly modelTriangles: number;
  readonly packTriangles: number;
  readonly modelNodes: number;
  readonly packNodes: number;
  readonly imageSize: number;
  readonly modelImages: number;
}

export const PACK_LIMITS: PackLimits = Object.freeze({
  packBytes: 16 << 20,
  manifestBytes: 256 << 10,
  pngBytes: 64 << 10,
  tile: 16,
  textures: 256,
  blocks: 1024,
  size: Object.freeze([128, 64, 128] as const),
  models: 16,
  objects: 256,
  markers: 64,
  cameras: 64,
  modelTriangles: 50_000,
  packTriangles: 150_000,
  modelNodes: 2_000,
  packNodes: 20_000,
  imageSize: 1024,
  modelImages: 8,
});

/** The glTF extensions a pack's models may use; anything else (Draco, meshopt, transmission…) is refused. */
export const GLTF_EXTENSIONS: readonly string[] = Object.freeze([
  'KHR_materials_unlit',
  'KHR_materials_emissive_strength',
  'KHR_texture_transform',
]);

export interface PackProblem {
  readonly path: string;
  readonly message: string;
}

/** A pack that is not valid, with every problem found (not only the first). */
export class PackError extends Error {
  readonly problems: readonly PackProblem[];
  constructor(problems: readonly PackProblem[]) {
    super(
      `The world pack is not valid:\n${problems.map((p) => `  ${p.path}: ${p.message}`).join('\n')}`,
    );
    this.name = 'PackError';
    this.problems = Object.freeze(problems.map((p) => Object.freeze({ ...p })));
  }
}

export type Vec3 = readonly [number, number, number];

export interface PackCredits {
  readonly authors: readonly string[];
  readonly license: string;
  readonly source?: string;
}

/** A GLB model placed in the world; `at` is in scene coordinates (the structure's origin added). */
export interface PackObject {
  readonly model: string;
  readonly at: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
}

/** A named place (scene coordinates); `front` is the way something put there faces, along the ground (x, z). */
export interface PackMarker {
  readonly name: string;
  readonly at: Vec3;
  readonly front?: readonly [number, number];
  readonly tags: readonly string[];
}

export interface PackCamera {
  readonly name: string;
  readonly eye: Vec3;
  readonly look: Vec3;
  readonly fov?: number;
  readonly focus?: readonly [number, number];
  readonly drift?: number;
}

export interface PackEnvironment {
  readonly sky: { readonly top: string; readonly horizon: string; readonly bottom: string };
  readonly fog: { readonly color: string; readonly near: number; readonly far: number };
  /** Tints of the blocks' baked light (MeshOptions), [r, g, b] 0..1. */
  readonly blocks: {
    readonly sky?: Vec3;
    readonly glow?: Vec3;
    readonly glow2?: Vec3;
    readonly minimum?: number;
    readonly occlusion?: number;
  };
  /** The sun, if any: baked into the blocks and seen in the sky. Direction towards it. */
  readonly sun?: {
    readonly direction: Vec3;
    readonly color: string;
    readonly strength: number;
    readonly reach?: number;
    readonly scatter?: number;
  };
  /**
   * The light of objects and guests: one set of colours, and where the key comes from (a marker,
   * scene coordinates). Strengths are given apart: objects are drawn in the world's pass, guests in
   * their own look (see docs/worlds/packs.md, Lighting and known transparency limitation).
   */
  readonly light: {
    readonly sky: string;
    readonly ground: string;
    readonly key: string;
    readonly from?: Vec3;
    readonly objects: { readonly key: number; readonly fill: number };
    readonly guest?: { readonly key: number; readonly fill: number };
  };
  readonly flicker?: number;
  readonly calm?: number;
}

/**
 * The pack's lighting (lighting.ts): its local light sources as scene data, presets of its own (each
 * complete or a change of a library preset), and the one to show by default — without one, the
 * stage shows `environment` as it always has.
 */
export interface PackLighting {
  readonly rig: readonly LightSource[];
  readonly presets: ReadonlyMap<string, LightingPreset>;
  readonly default?: string;
}

/**
 * A checked pack. Deeply frozen; bytes are never handed out, only copies (`cells()`, `texture()`,
 * `model()`), so nothing a caller does to what it gets changes the pack.
 */
export interface WorldPack {
  readonly format: number;
  readonly id: string;
  readonly version: string;
  /** SHA-256 of every file of the pack, in a canonical order (see docs/worlds/packs.md, Content hash). */
  readonly hash: string;
  readonly credits?: PackCredits;
  /** The blocks, as the engine's BlockRegistry takes them; ids are their order + 1. */
  readonly blocks: readonly BlockDefinition[];
  /**
   * `sides`: what is beside the box — "open" air (sky light comes in through the sides, the default:
   * a structure stands in the open) or "closed" (dark beyond its sides: a cave, a walled scene).
   */
  readonly structure: {
    readonly size: Vec3;
    readonly origin: Vec3;
    readonly sides: 'open' | 'closed';
    cells(): Uint16Array;
  };
  readonly textureNames: readonly string[];
  /** A tile's PNG bytes, a copy; an unknown name throws. */
  texture(name: string): ArrayBuffer;
  readonly modelNames: readonly string[];
  /** A model's GLB bytes, a copy; an unknown name throws. */
  model(name: string): ArrayBuffer;
  readonly objects: readonly PackObject[];
  readonly markers: ReadonlyMap<string, PackMarker>;
  readonly cameras: ReadonlyMap<string, PackCamera>;
  readonly environment: PackEnvironment;
  readonly lighting?: PackLighting;
  /** Accepted but worth knowing: say, a model's animations that format 1 ignores. */
  readonly warnings: readonly string[];
}

/**
 * Reads a pack's files over `fetch`, only inside `baseUrl` and only from the page's own origin (and
 * with no redirects): a pack can name no file outside its folder.
 */
export function packFilesAt(baseUrl: string | URL): PackFiles {
  const page = (globalThis as { location?: { href: string; origin: string } }).location;
  const base = new URL(baseUrl, page?.href);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  if (page && base.origin !== page.origin)
    throw new Error(`A pack is read from the page's own origin, not ${base.origin}.`);
  return async (path, signal) => {
    const problem = pathProblem(path);
    if (problem) throw new Error(`"${path}": ${problem}`);
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.href.startsWith(base.href))
      throw new Error(`"${path}" is outside the pack.`);
    const response = await fetch(url, { signal, credentials: 'same-origin', redirect: 'error' });
    if (!response.ok) throw new Error(`"${path}": HTTP ${response.status}.`);
    return response.arrayBuffer();
  };
}

/** Why a path may not name a file of a pack, or undefined: relative, normalised, inside the pack. */
export function pathProblem(path: string): string | undefined {
  if (typeof path !== 'string' || !path) return 'not a path';
  if (path.length > 200) return 'longer than 200 characters';
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return 'a URL (a scheme), not a path inside the pack';
  if (path.startsWith('/')) return 'absolute, not inside the pack';
  if (path.includes('\\')) return 'a backslash';
  if (!/^[A-Za-z0-9._/-]+$/.test(path))
    return 'characters other than letters, digits, ".", "_", "-" and "/"';
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..'))
    return 'not normalised (empty, "." or ".." segment)';
  return undefined;
}

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const SIDES: readonly BlockSide[] = ['north', 'south', 'east', 'west', 'up', 'down'];
const FRONTS: Record<string, readonly [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
};
const MODELS: Record<string, BlockModel> = {
  cube: 'cube',
  cross: 'cross',
  torch: 'torch',
  liquid: 'liquid',
  parts: 'boxes',
};

type Json = unknown;
type Obj = Record<string, Json>;

/** Collects problems with their place in pack.json; helpers return undefined for what is not valid. */
class Check {
  readonly problems: PackProblem[] = [];
  readonly warnings: string[] = [];
  problem(path: string, message: string): undefined {
    this.problems.push({ path, message });
    return undefined;
  }

  object(
    value: Json,
    path: string,
    keys: readonly string[],
    required: readonly string[] = [],
  ): Obj | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return this.problem(path, 'expected an object');
    const object = value as Obj;
    for (const key of Object.keys(object))
      if (!keys.includes(key))
        this.problem(`${path}.${key}`, 'unknown key (format 1 loses no data silently)');
    for (const key of required)
      if (object[key] === undefined) this.problem(`${path}.${key}`, 'missing');
    return object;
  }
  /** A map of names: an object whose keys are names. */
  names(value: Json, path: string, max: number): [string, Json][] {
    if (value === undefined) return [];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.problem(path, 'expected an object of names');
      return [];
    }
    const entries = Object.entries(value as Obj);
    if (entries.length > max) this.problem(path, `more than ${max} entries`);
    return entries.filter(
      ([name]) =>
        NAME.test(name) ||
        this.problem(`${path}.${name}`, 'not a name (letters, digits, "_", "-"; up to 64)'),
    );
  }
  array(value: Json, path: string, max: number): Json[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.problem(path, 'expected an array');
      return [];
    }
    if (value.length > max) this.problem(path, `more than ${max} entries`);
    return value;
  }
  string(value: Json, path: string, pattern?: RegExp, what = 'a string'): string | undefined {
    if (typeof value !== 'string' || (pattern && !pattern.test(value)))
      return this.problem(path, `expected ${what}`);
    return value;
  }
  number(value: Json, path: string, min = -Infinity, max = Infinity): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
      return this.problem(path, `expected a number in ${min}..${max}`);
    return value;
  }
  integer(value: Json, path: string, min: number, max: number): number | undefined {
    const n = this.number(value, path, min, max);
    return n === undefined || Number.isInteger(n)
      ? n
      : this.problem(path, 'expected a whole number');
  }
  tuple<N extends number>(
    value: Json,
    path: string,
    length: N,
    min = -Infinity,
    max = Infinity,
  ): number[] | undefined {
    if (!Array.isArray(value) || value.length !== length)
      return this.problem(path, `expected ${length} numbers`);
    const numbers = value.map((v, i) => this.number(v, `${path}[${i}]`, min, max));
    return numbers.every((n) => n !== undefined) ? (numbers as number[]) : undefined;
  }
  boolean(value: Json, path: string): boolean | undefined {
    return typeof value === 'boolean' ? value : this.problem(path, 'expected true or false');
  }
  file(value: Json, path: string, extension: string): string | undefined {
    const file = this.string(value, path);
    if (file === undefined) return undefined;
    const problem = pathProblem(file);
    if (problem) return this.problem(path, `"${file}": ${problem}`);
    if (!file.toLowerCase().endsWith(extension))
      return this.problem(path, `"${file}": expected a ${extension} file`);
    return file;
  }
}

/**
 * Web Crypto, for the pack's hash. A browser has it only in a secure context — a page from HTTPS or
 * from localhost (127.0.0.1, ::1) — so over plain HTTP from another host a pack cannot be read: said
 * plainly, before any file is fetched. The hash is never skipped instead.
 */
function subtle(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle)
    throw new Error(
      'Reading a world pack needs crypto.subtle, which a browser gives only to a secure context: serve the page over HTTPS or from localhost.',
    );
  return subtle;
}

const throwIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
};

/** Reads and checks a pack. Rejects with PackError (every problem) or the signal's reason. */
export async function readWorldPack(
  files: PackFiles,
  options: { signal: AbortSignal; limits?: Partial<PackLimits> },
): Promise<WorldPack> {
  const { signal } = options,
    limits: PackLimits = { ...PACK_LIMITS, ...options.limits };
  subtle();
  const check = new Check(),
    bytes = new Map<string, ArrayBuffer>();
  let total = 0;
  const read = async (path: string, max: number): Promise<ArrayBuffer | undefined> => {
    throwIfAborted(signal);
    if (bytes.has(path)) return bytes.get(path);
    let data: ArrayBuffer;
    try {
      data = await files(path, signal);
    } catch (error) {
      throwIfAborted(signal);
      return check.problem(
        path,
        `could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throwIfAborted(signal);
    // The pack's own copy: nothing the caller keeps of what it handed over is shared with the pack.
    data = data.slice(0);
    total += data.byteLength;
    if (data.byteLength > max)
      return check.problem(path, `${data.byteLength} bytes, more than ${max}`);
    if (total > limits.packBytes)
      return check.problem(path, `the pack is more than ${limits.packBytes} bytes`);
    bytes.set(path, data);
    return data;
  };

  const manifestBytes = await read('pack.json', limits.manifestBytes);
  if (!manifestBytes) throw new PackError(check.problems);
  let json: Json;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch (error) {
    throw new PackError([
      {
        path: 'pack.json',
        message: `not JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    ]);
  }

  const m = check.object(
    json,
    'pack',
    [
      'format',
      'id',
      'version',
      'requires',
      'credits',
      'textures',
      'blocks',
      'structure',
      'models',
      'objects',
      'markers',
      'cameras',
      'environment',
      'lighting',
    ],
    ['format', 'id', 'version', 'requires', 'textures', 'blocks', 'structure', 'environment'],
  );
  if (!m) throw new PackError(check.problems);
  // The format decides everything else: a pack of another format is not read further.
  if (m.format !== PACK_FORMAT)
    throw new PackError([
      {
        path: 'pack.format',
        message: `format ${JSON.stringify(m.format)}; this engine reads format ${PACK_FORMAT}`,
      },
    ]);
  const requires = check.object(m.requires, 'pack.requires', ['blockworld'], ['blockworld']);
  if (requires && requires.blockworld !== PACK_FORMAT)
    check.problem(
      'pack.requires.blockworld',
      `requires ${JSON.stringify(requires.blockworld)}; this engine is ${PACK_FORMAT}`,
    );
  const id =
    check.string(
      m.id,
      'pack.id',
      /^[a-z0-9][a-z0-9-]{0,63}$/,
      'an id (lower-case letters, digits, "-")',
    ) ?? '';
  // A free string of the author's: never compared, only shown and part of the stage id.
  const version =
    check.string(m.version, 'pack.version', /^.{1,32}$/, 'a version (1..32 characters)') ?? '';
  const credits = readCredits(check, m.credits);

  // Textures: names → PNG files.
  const textureFiles = new Map<string, string>();
  for (const [name, value] of check.names(m.textures, 'pack.textures', limits.textures)) {
    const file = check.file(value, `pack.textures.${name}`, '.png');
    if (file) textureFiles.set(name, file);
  }
  const tile = (value: Json, path: string): string | undefined => {
    const name = check.string(value, path);
    if (name !== undefined && !textureFiles.has(name))
      return check.problem(path, `no texture "${name}" in pack.textures`);
    return name;
  };

  const blocks = readBlocks(check, m.blocks, limits, tile);
  const blockIds = new Map(blocks.map((b, i) => [b.name, i + 1]));

  // Structure: size, origin, and exactly one of cells (a .u16 file) and layers (text).
  const s = check.object(
    m.structure,
    'pack.structure',
    ['size', 'origin', 'sides', 'cells', 'layers', 'legend'],
    ['size'],
  );
  const size = check.tuple(s?.size, 'pack.structure.size', 3, 1) as
    [number, number, number] | undefined;
  if (size)
    size.forEach((n, i) => {
      if (!Number.isInteger(n) || n > limits.size[i]!)
        check.problem(`pack.structure.size[${i}]`, `expected a whole number 1..${limits.size[i]}`);
    });
  const origin = (
    s?.origin === undefined ? [0, 0, 0] : check.tuple(s.origin, 'pack.structure.origin', 3)
  ) as Vec3 | undefined;
  if (s && (s.cells === undefined) === (s.layers === undefined))
    check.problem('pack.structure', 'exactly one of "cells" and "layers"');
  if (s && s.legend !== undefined && s.layers === undefined)
    check.problem('pack.structure.legend', 'only with "layers"');
  const cellsFile =
    s?.cells !== undefined ? check.file(s.cells, 'pack.structure.cells', '.u16') : undefined;
  const sides =
    s?.sides === undefined
      ? 'open'
      : (check.string(s.sides, 'pack.structure.sides', /^(open|closed)$/, '"open" or "closed"') as
          'open' | 'closed' | undefined);

  // Models: names → GLB files.
  const modelFiles = new Map<string, string>();
  for (const [name, value] of check.names(m.models, 'pack.models', limits.models)) {
    const file = check.file(value, `pack.models.${name}`, '.glb');
    if (file) modelFiles.set(name, file);
  }

  // Places are given in cells of the structure; the scene has them with the origin added.
  const [ox, oy, oz] = origin ?? [0, 0, 0];
  const scene = (p: readonly number[]): Vec3 => [p[0]! + ox, p[1]! + oy, p[2]! + oz];
  const inside = (p: readonly number[] | undefined, path: string) => {
    if (p && size && p.some((v, i) => v < 0 || v > size[i]!))
      check.problem(path, `outside the structure (0..${size.join(', 0..')})`);
    return p;
  };

  const markers = new Map<string, PackMarker>();
  for (const [name, value] of check.names(m.markers, 'pack.markers', limits.markers)) {
    const path = `pack.markers.${name}`,
      o = check.object(value, path, ['at', 'front', 'tags'], ['at']);
    if (!o) continue;
    const at = inside(check.tuple(o.at, `${path}.at`, 3), `${path}.at`);
    let front: readonly [number, number] | undefined;
    if (typeof o.front === 'string')
      front =
        FRONTS[o.front] ??
        check.problem(`${path}.front`, 'expected north, south, east, west or [x, z]');
    else if (o.front !== undefined) {
      const f = check.tuple(o.front, `${path}.front`, 2);
      if (f && Math.hypot(f[0]!, f[1]!) === 0)
        check.problem(`${path}.front`, 'a direction, not [0, 0]');
      else if (f) front = [f[0]!, f[1]!];
    }
    const tags = check
      .array(o.tags, `${path}.tags`, 16)
      .map((t, i) => check.string(t, `${path}.tags[${i}]`, NAME, 'a tag'))
      .filter((t): t is string => t !== undefined);
    if (at) markers.set(name, { name, at: scene(at), ...(front ? { front } : {}), tags });
  }
  const point = (value: Json, path: string): Vec3 | undefined => {
    if (typeof value === 'string') {
      const marker = markers.get(value);
      return marker ? marker.at : check.problem(path, `no marker "${value}" in pack.markers`);
    }
    const p = check.tuple(value, path, 3);
    return p ? scene(p) : undefined;
  };

  const cameras = new Map<string, PackCamera>();
  for (const [name, value] of check.names(m.cameras, 'pack.cameras', limits.cameras)) {
    const path = `pack.cameras.${name}`,
      o = check.object(value, path, ['eye', 'look', 'fov', 'focus', 'drift'], ['eye', 'look']);
    if (!o) continue;
    const eye = point(o.eye, `${path}.eye`),
      look = point(o.look, `${path}.look`);
    const fov = o.fov === undefined ? undefined : check.number(o.fov, `${path}.fov`, 10, 120);
    const focus =
      o.focus === undefined ? undefined : check.tuple(o.focus, `${path}.focus`, 2, 0, 1);
    const drift = o.drift === undefined ? undefined : check.number(o.drift, `${path}.drift`, 0, 2);
    if (eye && look)
      cameras.set(name, {
        name,
        eye,
        look,
        ...(fov !== undefined ? { fov } : {}),
        ...(focus ? { focus: [focus[0]!, focus[1]!] } : {}),
        ...(drift !== undefined ? { drift } : {}),
      });
  }

  const objects: PackObject[] = [];
  check.array(m.objects, 'pack.objects', limits.objects).forEach((value, i) => {
    const path = `pack.objects[${i}]`,
      o = check.object(value, path, ['model', 'at', 'rotation', 'scale'], ['model', 'at']);
    if (!o) return;
    const model = check.string(o.model, `${path}.model`);
    if (model !== undefined && !modelFiles.has(model))
      check.problem(`${path}.model`, `no model "${model}" in pack.models`);
    const at = inside(check.tuple(o.at, `${path}.at`, 3), `${path}.at`);
    const rotation =
      o.rotation === undefined
        ? [0, 0, 0]
        : check.tuple(o.rotation, `${path}.rotation`, 3, -360, 360);
    const scale =
      o.scale === undefined
        ? [1, 1, 1]
        : typeof o.scale === 'number'
          ? [o.scale, o.scale, o.scale]
          : check.tuple(o.scale, `${path}.scale`, 3);
    if (scale && scale.some((v) => !(v > 0 && v <= 64)))
      check.problem(`${path}.scale`, 'expected a scale in (0, 64]');
    if (model !== undefined && at && rotation && scale)
      objects.push({
        model,
        at: scene(at),
        rotation: rotation as unknown as Vec3,
        scale: scale as unknown as Vec3,
      });
  });

  const environment = readEnvironment(check, m.environment, markers);
  const lighting = m.lighting === undefined ? undefined : readLighting(check, m.lighting, markers);

  // The files pack.json names, and nothing else.
  const pngs = new Map<string, ArrayBuffer>(),
    glbs = new Map<string, ArrayBuffer>();
  for (const [name, file] of textureFiles) {
    const data = await read(file, limits.pngBytes);
    if (data && checkPng(check, `pack.textures.${name} (${file})`, data, limits))
      pngs.set(name, data);
  }
  const weights = new Map<string, { triangles: number; nodes: number }>();
  for (const [name, file] of modelFiles) {
    const data = await read(file, limits.packBytes);
    const weight = data && checkGlb(check, `pack.models.${name} (${file})`, data, limits);
    if (data && weight) {
      glbs.set(name, data);
      weights.set(name, weight);
    }
  }
  // A model placed n times is drawn n times: its weight counts for every object.
  const placed = (key: 'triangles' | 'nodes') =>
    objects.reduce((sum, o) => sum + (weights.get(o.model)?.[key] ?? 0), 0);
  if (placed('triangles') > limits.packTriangles)
    check.problem(
      'pack.objects',
      `${placed('triangles')} triangles placed (every object counts its model), more than ${limits.packTriangles}`,
    );
  if (placed('nodes') > limits.packNodes)
    check.problem(
      'pack.objects',
      `${placed('nodes')} nodes placed (every object counts its model), more than ${limits.packNodes}`,
    );

  let cells: Uint16Array | undefined;
  if (size && s) {
    if (cellsFile) {
      const data = await read(cellsFile, limits.packBytes);
      if (data)
        cells = readCells(check, `pack.structure.cells (${cellsFile})`, data, size, blocks.length);
    } else if (s.layers !== undefined)
      cells = readLayers(check, s.layers, s.legend, size, blockIds);
  }

  throwIfAborted(signal);
  if (check.problems.length) throw new PackError(check.problems);
  const hash = await packHash(bytes);
  throwIfAborted(signal);

  const copy =
    (map: Map<string, ArrayBuffer>, kind: string) =>
    (name: string): ArrayBuffer => {
      const data = map.get(name);
      if (!data) throw new Error(`The pack has no ${kind} "${name}".`);
      return data.slice(0);
    };
  const grid = cells!;
  return deepFreeze({
    format: PACK_FORMAT,
    id,
    version,
    hash,
    ...(credits ? { credits } : {}),
    blocks,
    structure: { size: size!, origin: origin!, sides: sides!, cells: () => grid.slice() },
    textureNames: [...pngs.keys()],
    texture: copy(pngs, 'texture'),
    modelNames: [...glbs.keys()],
    model: copy(glbs, 'model'),
    objects,
    markers: readonlyMap(markers),
    cameras: readonlyMap(cameras),
    environment,
    ...(lighting ? { lighting } : {}),
    warnings: check.warnings,
  });
}

function readCredits(check: Check, value: Json): PackCredits | undefined {
  if (value === undefined) return undefined;
  // A statement of the author's; checked for shape only, it proves no right to anything (docs §5.3).
  const o = check.object(
    value,
    'pack.credits',
    ['authors', 'license', 'source'],
    ['authors', 'license'],
  );
  if (!o) return undefined;
  const authors = check
    .array(o.authors, 'pack.credits.authors', 32)
    .map((a, i) => check.string(a, `pack.credits.authors[${i}]`, /^.{1,200}$/))
    .filter((a): a is string => a !== undefined);
  const license = check.string(o.license, 'pack.credits.license', /^.{1,64}$/);
  const source =
    o.source === undefined
      ? undefined
      : check.string(o.source, 'pack.credits.source', /^.{1,500}$/);
  return license === undefined
    ? undefined
    : { authors, license, ...(source !== undefined ? { source } : {}) };
}

function readBlocks(
  check: Check,
  value: Json,
  limits: PackLimits,
  tile: (value: Json, path: string) => string | undefined,
): BlockDefinition[] {
  const blocks: BlockDefinition[] = [],
    seen = new Set<string>();
  check.array(value, 'pack.blocks', limits.blocks).forEach((entry, i) => {
    const path = `pack.blocks[${i}]`;
    const o = check.object(
      entry,
      path,
      ['name', 'model', 'textures', 'transparent', 'cutout', 'light', 'secondLight', 'parts'],
      ['name', 'textures'],
    );
    if (!o) return;
    const name = check.string(o.name, `${path}.name`, NAME, 'a name');
    if (name !== undefined && seen.has(name))
      check.problem(`${path}.name`, `block "${name}" is defined twice`);
    if (name !== undefined) seen.add(name);
    const modelName = o.model === undefined ? 'cube' : check.string(o.model, `${path}.model`);
    const model =
      modelName === undefined
        ? undefined
        : (MODELS[modelName] ??
          check.problem(`${path}.model`, `expected ${Object.keys(MODELS).join(', ')}`));
    const t = check.object(o.textures, `${path}.textures`, [
      'all',
      'top',
      'bottom',
      'side',
      ...SIDES,
    ]);
    const textures: Record<string, string> = {};
    for (const [key, v] of Object.entries(t ?? {})) {
      const name = tile(v, `${path}.textures.${key}`);
      if (name !== undefined) textures[key] = name;
    }
    // Every side must have a tile by the fallback rules (BlockTextures); a pack never falls back to stone.
    const has = (...keys: string[]) => keys.some((k) => textures[k] !== undefined);
    if (t)
      for (const side of SIDES) {
        const ok =
          side === 'up'
            ? has('up', 'top', 'all', 'side')
            : side === 'down'
              ? has('down', 'bottom', 'all', 'top', 'side')
              : has(side, 'side', 'all');
        if (!ok)
          check.problem(
            `${path}.textures`,
            `no texture for the ${side} side (give "${side}", ${side === 'up' ? '"top"' : side === 'down' ? '"bottom"' : '"side"'} or "all")`,
          );
      }
    const boxes: BlockPart[] = [];
    if (model === 'boxes') {
      const parts = check.array(o.parts, `${path}.parts`, 32);
      if (!parts.length) check.problem(`${path}.parts`, 'a "parts" block needs at least one part');
      parts.forEach((p, j) => {
        const part = readPart(check, p, `${path}.parts[${j}]`, tile);
        if (part) boxes.push(part);
      });
    } else if (o.parts !== undefined) check.problem(`${path}.parts`, 'only for model "parts"');
    const flag = (key: string) =>
      o[key] === undefined ? undefined : check.boolean(o[key], `${path}.${key}`);
    const light =
      o.light === undefined ? undefined : check.integer(o.light, `${path}.light`, 0, 15);
    if (name === undefined || model === undefined) return;
    const transparent = flag('transparent'),
      cutout = flag('cutout'),
      secondLight = flag('secondLight');
    blocks.push({
      name,
      model,
      textures: textures as BlockTextures,
      ...(transparent !== undefined ? { transparent } : {}),
      ...(cutout !== undefined ? { cutout } : {}),
      ...(light !== undefined ? { light } : {}),
      ...(secondLight !== undefined ? { secondLight } : {}),
      ...(model === 'boxes' ? { boxes } : {}),
    });
  });
  return blocks;
}

function readPart(
  check: Check,
  value: Json,
  path: string,
  tile: (value: Json, path: string) => string | undefined,
): BlockPart | undefined {
  const o = check.object(value, path, ['from', 'to', 'faces'], ['from', 'to']);
  if (!o) return undefined;
  const from = check.tuple(o.from, `${path}.from`, 3, 0, 16),
    to = check.tuple(o.to, `${path}.to`, 3, 0, 16);
  if (from && to && from.some((v, i) => v > to[i]!))
    check.problem(path, '"from" must not be past "to"');
  if (from && to && from.every((v, i) => v === to[i])) check.problem(path, 'an empty part');
  const f = o.faces === undefined ? undefined : check.object(o.faces, `${path}.faces`, SIDES);
  const faces: Partial<Record<BlockSide, PartFace>> = {};
  for (const [side, v] of Object.entries(f ?? {})) {
    const fp = `${path}.faces.${side}`,
      face = check.object(v, fp, ['texture', 'uv']);
    if (!face) continue;
    const texture = face.texture === undefined ? undefined : tile(face.texture, `${fp}.texture`);
    const uv = face.uv === undefined ? undefined : check.tuple(face.uv, `${fp}.uv`, 4, 0, 16);
    if (uv && (uv[0] === uv[2] || uv[1] === uv[3]))
      check.problem(`${fp}.uv`, 'an empty rectangle of the tile');
    faces[side as BlockSide] = {
      ...(texture !== undefined ? { texture } : {}),
      ...(uv ? { uv: uv as unknown as [number, number, number, number] } : {}),
    };
  }
  if (!from || !to) return undefined;
  return { from: from as unknown as Vec3, to: to as unknown as Vec3, ...(f ? { faces } : {}) };
}

function readEnvironment(
  check: Check,
  value: Json,
  markers: ReadonlyMap<string, PackMarker>,
): PackEnvironment {
  const o =
    check.object(
      value,
      'pack.environment',
      ['sky', 'fog', 'blocks', 'sun', 'light', 'flicker', 'calm'],
      ['sky', 'fog', 'light'],
    ) ?? {};
  const color = (v: Json, path: string) =>
    check.string(v, path, COLOR, 'a colour "#rrggbb"') ?? '#000000';
  const sky =
    check.object(
      o.sky,
      'pack.environment.sky',
      ['top', 'horizon', 'bottom'],
      ['top', 'horizon', 'bottom'],
    ) ?? {};
  const fog =
    check.object(
      o.fog,
      'pack.environment.fog',
      ['color', 'near', 'far'],
      ['color', 'near', 'far'],
    ) ?? {};
  const near = check.number(fog.near, 'pack.environment.fog.near', 0, 2000) ?? 0,
    far = check.number(fog.far, 'pack.environment.fog.far', 0, 2000) ?? 1;
  if (far <= near) check.problem('pack.environment.fog', '"far" must be past "near"');
  const b =
    o.blocks === undefined
      ? {}
      : (check.object(o.blocks, 'pack.environment.blocks', [
          'sky',
          'glow',
          'glow2',
          'minimum',
          'occlusion',
        ]) ?? {});
  const tint = (key: string) =>
    b[key] === undefined
      ? {}
      : { [key]: check.tuple(b[key], `pack.environment.blocks.${key}`, 3, 0, 2) };
  const unit = (key: string) =>
    b[key] === undefined
      ? {}
      : { [key]: check.number(b[key], `pack.environment.blocks.${key}`, 0, 1) };
  let sun: PackEnvironment['sun'];
  if (o.sun !== undefined) {
    const s = check.object(
      o.sun,
      'pack.environment.sun',
      ['direction', 'color', 'strength', 'reach', 'scatter'],
      ['direction', 'color', 'strength'],
    );
    const direction = s && check.tuple(s.direction, 'pack.environment.sun.direction', 3);
    const strength = s && check.number(s.strength, 'pack.environment.sun.strength', 0, 1);
    const reach =
      s?.reach === undefined
        ? undefined
        : check.number(s.reach, 'pack.environment.sun.reach', 1, 256);
    const scatter =
      s?.scatter === undefined
        ? undefined
        : check.number(s.scatter, 'pack.environment.sun.scatter', 0, 2);
    if (s && direction && strength !== undefined)
      sun = {
        direction: direction as unknown as Vec3,
        color: color(s.color, 'pack.environment.sun.color'),
        strength,
        ...(reach !== undefined ? { reach } : {}),
        ...(scatter !== undefined ? { scatter } : {}),
      };
  }
  const l =
    check.object(
      o.light,
      'pack.environment.light',
      ['sky', 'ground', 'key', 'from', 'objects', 'guest'],
      ['sky', 'ground', 'key'],
    ) ?? {};
  const strengths = (v: Json, path: string, fallback?: { key: number; fill: number }) => {
    if (v === undefined) return fallback;
    const s = check.object(v, path, ['key', 'fill'], ['key', 'fill']);
    const key = s && check.number(s.key, `${path}.key`, 0, 50),
      fill = s && check.number(s.fill, `${path}.fill`, 0, 50);
    return key !== undefined && fill !== undefined ? { key, fill } : undefined;
  };
  let from: Vec3 | undefined;
  if (l.from !== undefined) {
    const name = check.string(l.from, 'pack.environment.light.from');
    from =
      name === undefined
        ? undefined
        : (markers.get(name)?.at ??
          check.problem('pack.environment.light.from', `no marker "${name}" in pack.markers`));
  }
  const guest = strengths(l.guest, 'pack.environment.light.guest');
  const flicker =
    o.flicker === undefined
      ? undefined
      : check.number(o.flicker, 'pack.environment.flicker', 0, 0.5);
  const calm =
    o.calm === undefined ? undefined : check.number(o.calm, 'pack.environment.calm', 0, 1);
  return {
    sky: {
      top: color(sky.top, 'pack.environment.sky.top'),
      horizon: color(sky.horizon, 'pack.environment.sky.horizon'),
      bottom: color(sky.bottom, 'pack.environment.sky.bottom'),
    },
    fog: { color: color(fog.color, 'pack.environment.fog.color'), near, far },
    blocks: {
      ...tint('sky'),
      ...tint('glow'),
      ...tint('glow2'),
      ...unit('minimum'),
      ...unit('occlusion'),
    } as PackEnvironment['blocks'],
    ...(sun ? { sun } : {}),
    light: {
      sky: color(l.sky, 'pack.environment.light.sky'),
      ground: color(l.ground, 'pack.environment.light.ground'),
      key: color(l.key, 'pack.environment.light.key'),
      ...(from ? { from } : {}),
      objects: strengths(l.objects, 'pack.environment.light.objects', { key: 1.6, fill: 0.9 }) ?? {
        key: 1.6,
        fill: 0.9,
      },
      ...(guest ? { guest } : {}),
    },
    ...(flicker !== undefined ? { flicker } : {}),
    ...(calm !== undefined ? { calm } : {}),
  };
}

function readLighting(
  check: Check,
  value: Json,
  markers: ReadonlyMap<string, PackMarker>,
): PackLighting | undefined {
  const o = check.object(value, 'pack.lighting', ['rig', 'presets', 'default']);
  if (!o) return undefined;
  const names = new Set(markers.keys()),
    problems: { path: string; message: string }[] = [];
  const rig = o.rig === undefined ? [] : checkSources(o.rig, 'pack.lighting.rig', problems, names);
  const presets = new Map<string, LightingPreset>();
  for (const [name, entry] of check.names(o.presets, 'pack.lighting.presets', 16)) {
    const path = `pack.lighting.presets.${name}`;
    try {
      // Named by its key; `base` may be a library preset or one of the pack's above it.
      const preset = readLightingPreset(
        entry && typeof entry === 'object' && !Array.isArray(entry) ? { name, ...entry } : entry,
        (base) => presets.get(base) ?? LIGHTING_PRESETS[base],
      );
      const places = [
        ...preset.lights.map((l) => l.at),
        ...(typeof preset.key.from === 'object' ? [preset.key.from.at] : []),
      ];
      for (const place of places)
        if (typeof place === 'string' && place !== '@anchor' && !names.has(place))
          problems.push({ path, message: `no marker "${place}" in pack.markers` });
      presets.set(name, preset);
    } catch (error) {
      if (!(error instanceof LightingError)) throw error;
      for (const p of error.problems)
        problems.push({ path: `${path}.${p.path}`, message: p.message });
    }
  }
  for (const p of problems) check.problem(p.path, p.message);
  const fallback =
    o.default === undefined ? undefined : check.string(o.default, 'pack.lighting.default');
  if (fallback !== undefined && !presets.has(fallback) && !LIGHTING_PRESETS[fallback])
    check.problem(
      'pack.lighting.default',
      `no preset "${fallback}" in pack.lighting.presets or the library`,
    );
  return {
    rig,
    presets: readonlyMap(presets),
    ...(fallback !== undefined ? { default: fallback } : {}),
  };
}

/** `.u16`: little-endian, no header, exactly 2·sx·sy·sz bytes, i = x + sx·(y + sy·z); 0 air, n blocks[n−1]. */
function readCells(
  check: Check,
  path: string,
  data: ArrayBuffer,
  size: readonly [number, number, number],
  blocks: number,
): Uint16Array | undefined {
  const count = size[0] * size[1] * size[2];
  if (data.byteLength !== 2 * count)
    return check.problem(
      path,
      `${data.byteLength} bytes; a ${size.join('×')} structure is exactly ${2 * count}`,
    );
  const view = new DataView(data),
    cells = new Uint16Array(count);
  let bad = 0,
    first = -1;
  for (let i = 0; i < count; i++) {
    const v = view.getUint16(2 * i, true);
    if (v > blocks) {
      bad++;
      if (first < 0) first = i;
    }
    cells[i] = v;
  }
  if (bad) {
    const x = first % size[0],
      y = Math.floor(first / size[0]) % size[1],
      z = Math.floor(first / (size[0] * size[1]));
    return check.problem(
      path,
      `${bad} cells name a block past the ${blocks} defined (first at x ${x}, y ${y}, z ${z}: ${view.getUint16(2 * first, true)})`,
    );
  }
  return cells;
}

/** `layers[y][z]`: a string of `sx` characters per row; `legend` maps a character to a block, "." is air. */
function readLayers(
  check: Check,
  layers: Json,
  legend: Json,
  size: readonly [number, number, number],
  ids: ReadonlyMap<string, number>,
): Uint16Array | undefined {
  const [sx, sy, sz] = size,
    cells = new Uint16Array(sx * sy * sz),
    key = new Map<string, number>([['.', 0]]);
  if (typeof legend !== 'object' || legend === null || Array.isArray(legend))
    return check.problem('pack.structure.legend', 'expected an object of characters');
  for (const [char, name] of Object.entries(legend as Obj)) {
    if ([...char].length !== 1 || char === '.') {
      check.problem(`pack.structure.legend.${char}`, 'one character other than "."');
      continue;
    }
    const id = typeof name === 'string' ? ids.get(name) : undefined;
    if (id === undefined)
      check.problem(
        `pack.structure.legend.${char}`,
        `no block ${JSON.stringify(name)} in pack.blocks`,
      );
    else key.set(char, id);
  }
  if (!Array.isArray(layers) || layers.length !== sy)
    return check.problem('pack.structure.layers', `expected ${sy} layers (one per y)`);
  let ok = true;
  layers.forEach((layer, y) => {
    if (!Array.isArray(layer) || layer.length !== sz) {
      ok = false;
      check.problem(`pack.structure.layers[${y}]`, `expected ${sz} rows (one per z)`);
      return;
    }
    layer.forEach((row, z) => {
      const chars = typeof row === 'string' ? [...row] : [];
      if (chars.length !== sx) {
        ok = false;
        check.problem(`pack.structure.layers[${y}][${z}]`, `expected a string of ${sx} characters`);
        return;
      }
      chars.forEach((c, x) => {
        const id = key.get(c);
        if (id === undefined) {
          ok = false;
          check.problem(
            `pack.structure.layers[${y}][${z}]`,
            `"${c}" at x ${x} is not in the legend`,
          );
        } else cells[x + sx * (y + sy * z)] = id;
      });
    });
  });
  return ok ? cells : undefined;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** A PNG by its signature and header (no decoding): 8-bit, not interlaced, tile × tile pixels. */
function checkPng(check: Check, path: string, data: ArrayBuffer, limits: PackLimits): boolean {
  const b = new Uint8Array(data),
    view = new DataView(data);
  if (b.length < 33 || PNG_SIGNATURE.some((v, i) => b[i] !== v))
    return check.problem(path, 'not a PNG (signature)') ?? false;
  if (String.fromCharCode(...b.subarray(12, 16)) !== 'IHDR')
    return check.problem(path, 'not a PNG (no IHDR first)') ?? false;
  const width = view.getUint32(16),
    height = view.getUint32(20),
    depth = b[24]!,
    type = b[25]!,
    interlace = b[28]!;
  if (width !== limits.tile || height !== limits.tile)
    return (
      check.problem(path, `${width}×${height}; a tile is ${limits.tile}×${limits.tile}`) ?? false
    );
  if (depth !== 8 || ![0, 2, 3, 4, 6].includes(type))
    return (
      check.problem(
        path,
        `bit depth ${depth}, colour type ${type}: format 1 takes 8-bit grey, RGB, palette, grey+alpha or RGBA`,
      ) ?? false
    );
  if (interlace !== 0)
    return check.problem(path, 'interlaced; format 1 takes non-interlaced PNG') ?? false;
  return true;
}

/** Width and height of an embedded image by its header, if it is the type it says it is. */
function imageSize(b: Uint8Array, mimeType: string): [number, number] | undefined {
  if (mimeType === 'image/png') {
    if (
      b.length < 24 ||
      PNG_SIGNATURE.some((v, i) => b[i] !== v) ||
      String.fromCharCode(...b.subarray(12, 16)) !== 'IHDR'
    )
      return undefined;
    const v = new DataView(b.buffer, b.byteOffset);
    return [v.getUint32(16), v.getUint32(20)];
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!,
        length = (b[i + 2]! << 8) | b[i + 3]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return [(b[i + 7]! << 8) | b[i + 8]!, (b[i + 5]! << 8) | b[i + 6]!];
      i += 2 + length;
    }
  }
  return undefined;
}

type GltfJson = Record<string, unknown>;

const COMPONENT_BYTES: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
const TYPE_SIZE: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

/**
 * A GLB by its container and JSON (no decoding), read the way three's GLTFLoader reads it, so what
 * passes here is what the loader builds — and no more:
 * - the container: glTF binary 2, its length the file's; a JSON chunk first, then at most one BIN
 *   chunk, nothing else (the loader takes the last JSON chunk it meets: two are refused, not guessed);
 * - everything inside: no URI on a buffer or image, one buffer (the BIN chunk);
 * - only the allowed extensions, wherever an `extensions` object stands — the loader's texture
 *   plugins act on a texture's extensions even when `extensionsUsed` does not name them;
 * - one scene, every node in it exactly once (the loader builds every scene and every node an
 *   animation names; what it builds outside the scene would be owned by no one);
 * - buffer views and accessors inside the BIN chunk, of known types; no sparse accessors, no
 *   accessor without data (the loader would make one of `count` zeros), no morph targets, no skins,
 *   triangles only (points and lines would escape the triangle count);
 * - embedded PNG or JPEG images, few and within the size limit.
 * Returns its triangles and nodes over the scene (a mesh on ten nodes counts ten times).
 */
function checkGlb(
  check: Check,
  path: string,
  data: ArrayBuffer,
  limits: PackLimits,
): { triangles: number; nodes: number } | undefined {
  const view = new DataView(data),
    b = new Uint8Array(data);
  if (data.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67)
    return check.problem(path, 'not a GLB (magic)');
  if (view.getUint32(4, true) !== 2)
    return check.problem(path, `glTF binary version ${view.getUint32(4, true)}; format 1 takes 2`);
  if (view.getUint32(8, true) !== data.byteLength)
    return check.problem(
      path,
      `the header says ${view.getUint32(8, true)} bytes, the file has ${data.byteLength}`,
    );
  const chunks: { type: number; body: Uint8Array }[] = [];
  for (let at = 12; at < data.byteLength;) {
    if (at + 8 > data.byteLength) return check.problem(path, 'a chunk header past the end');
    const length = view.getUint32(at, true),
      type = view.getUint32(at + 4, true);
    if (length > data.byteLength - at - 8) return check.problem(path, 'a chunk past the end');
    if (length % 4) return check.problem(path, 'a chunk not aligned to 4 bytes');
    chunks.push({ type, body: b.subarray(at + 8, at + 8 + length) });
    at += 8 + length;
  }
  if (chunks[0]?.type !== 0x4e4f534a) return check.problem(path, 'the first chunk is not JSON');
  if (chunks.length > 2 || (chunks[1] && chunks[1].type !== 0x004e4942))
    return check.problem(path, 'chunks other than one JSON and one BIN');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(chunks[0].body));
  } catch {
    return check.problem(path, 'its JSON chunk is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return check.problem(path, 'its JSON is not an object');
  const gltf = parsed as GltfJson,
    bin = chunks[1]?.body ?? new Uint8Array(0);
  const start = check.problems.length,
    problem = (message: string) => {
      check.problem(path, message);
    };
  const list = (key: string): GltfJson[] => {
    const value = gltf[key];
    if (value === undefined) return [];
    if (
      !Array.isArray(value) ||
      value.some((v) => typeof v !== 'object' || v === null || Array.isArray(v))
    ) {
      problem(`"${key}" is not an array of objects`);
      return [];
    }
    return value as GltfJson[];
  };
  const whole = (v: unknown, min = 0) => typeof v === 'number' && Number.isInteger(v) && v >= min;
  const index = (v: unknown, of: readonly unknown[]) => whole(v) && (v as number) < of.length;

  if ((gltf.asset as GltfJson | undefined)?.version !== '2.0')
    problem(
      `glTF version ${JSON.stringify((gltf.asset as GltfJson | undefined)?.version)}; format 1 takes "2.0"`,
    );
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    const names = gltf[key];
    if (names !== undefined && !Array.isArray(names)) problem(`"${key}" is not an array`);
    for (const extension of Array.isArray(names) ? names : [])
      if (!GLTF_EXTENSIONS.includes(extension))
        problem(`uses ${extension}; format 1 allows ${GLTF_EXTENSIONS.join(', ')}`);
  }
  // Every `extensions` object anywhere: a plugin may act on it whatever extensionsUsed says.
  const walk = (value: unknown, at: string): void => {
    if (typeof value !== 'object' || value === null) return;
    for (const [key, v] of Object.entries(value)) {
      if (key === 'extensions' && typeof v === 'object' && v !== null)
        for (const name of Object.keys(v))
          if (!GLTF_EXTENSIONS.includes(name))
            problem(`${at} uses ${name}; format 1 allows ${GLTF_EXTENSIONS.join(', ')}`);
      if (key !== 'extras') walk(v, `${at}.${key}`);
    }
  };
  walk(gltf, 'gltf');

  const buffers = list('buffers'),
    bufferViews = list('bufferViews'),
    accessors = list('accessors'),
    images = list('images');
  const meshes = list('meshes'),
    nodes = list('nodes'),
    scenes = list('scenes'),
    textures = list('textures');
  if (buffers.length > 1)
    problem("more than one buffer; a pack's model keeps everything in its BIN chunk");
  if (buffers[0]) {
    if (buffers[0].uri !== undefined)
      problem("buffer 0 has a URI; a pack's model keeps everything in its BIN chunk");
    else if (!whole(buffers[0].byteLength, 1) || (buffers[0].byteLength as number) > bin.length)
      problem('buffer 0 is not inside the BIN chunk');
  }
  const viewLength = (v: GltfJson) => v.byteLength as number;
  bufferViews.forEach((v, i) => {
    if (
      v.buffer !== 0 ||
      !buffers.length ||
      !whole(v.byteOffset ?? 0) ||
      !whole(v.byteLength, 1) ||
      ((v.byteOffset as number) ?? 0) + viewLength(v) > bin.length
    )
      problem(`bufferView ${i} is not inside the BIN chunk`);
    else if (
      v.byteStride !== undefined &&
      (!whole(v.byteStride, 4) || (v.byteStride as number) > 252 || (v.byteStride as number) % 4)
    )
      problem(`bufferView ${i} has a byteStride outside 4..252`);
  });
  accessors.forEach((a, i) => {
    const size = COMPONENT_BYTES[a.componentType as number],
      items = TYPE_SIZE[a.type as string];
    if (a.sparse !== undefined) {
      problem(`accessor ${i} is sparse; format 1 takes plain accessors`);
      return;
    }
    if (!size || !items || !whole(a.count, 1)) {
      problem(`accessor ${i} has no valid componentType, type or count`);
      return;
    }
    if (!index(a.bufferView, bufferViews)) {
      problem(`accessor ${i} has no buffer view (format 1 takes no accessor of zeros)`);
      return;
    }
    const v = bufferViews[a.bufferView as number]!,
      element = size * items,
      stride = (v.byteStride as number | undefined) ?? element,
      offset = (a.byteOffset as number | undefined) ?? 0;
    if (
      !whole(offset) ||
      offset % size ||
      offset + stride * ((a.count as number) - 1) + element > viewLength(v)
    )
      problem(`accessor ${i} reads past its buffer view`);
  });
  images.forEach((image, i) => {
    if (image.uri !== undefined) {
      problem(`image ${i} has a URI; images live in the BIN chunk`);
      return;
    }
    if (image.mimeType !== 'image/png' && image.mimeType !== 'image/jpeg') {
      problem(`image ${i} is ${image.mimeType}; format 1 takes PNG and JPEG`);
      return;
    }
    const v = index(image.bufferView, bufferViews)
      ? bufferViews[image.bufferView as number]
      : undefined;
    const bytes =
      v &&
      bin.subarray(
        (v.byteOffset as number | undefined) ?? 0,
        ((v.byteOffset as number | undefined) ?? 0) + viewLength(v),
      );
    const size = bytes && imageSize(bytes, image.mimeType);
    if (!size)
      problem(`image ${i} is not a readable ${image.mimeType === 'image/png' ? 'PNG' : 'JPEG'}`);
    else if (size[0] > limits.imageSize || size[1] > limits.imageSize)
      problem(
        `image ${i} is ${size[0]}×${size[1]}, more than ${limits.imageSize}×${limits.imageSize}`,
      );
  });
  if (images.length > limits.modelImages)
    problem(`${images.length} images, more than ${limits.modelImages}`);
  textures.forEach((t, i) => {
    if (t.source !== undefined && !index(t.source, images)) problem(`texture ${i} names no image`);
  });
  if (list('skins').length) problem('skins; format 1 models are still');
  if (Array.isArray(gltf.animations) && gltf.animations.length)
    check.warnings.push(
      `${path}: ${gltf.animations.length} animation(s) ignored; format 1 models are still`,
    );

  // Triangles of a mesh, its primitives' indices (or vertices) read as triangles, strips or fans.
  const meshTriangles = meshes.map((mesh, i) => {
    const primitives = Array.isArray(mesh.primitives) ? (mesh.primitives as GltfJson[]) : [];
    if (!primitives.length) problem(`mesh ${i} has no primitives`);
    return primitives.reduce((sum, p) => {
      const attributes = (p.attributes ?? {}) as Record<string, unknown>,
        mode = (p.mode as number | undefined) ?? 4;
      if (p.targets !== undefined)
        problem(`mesh ${i} has morph targets; format 1 models are still`);
      if (![4, 5, 6].includes(mode))
        problem(`mesh ${i} draws mode ${mode}; format 1 takes triangles, strips and fans`);
      if (
        !index(attributes.POSITION, accessors) ||
        Object.values(attributes).some((a) => !index(a, accessors))
      )
        problem(`mesh ${i} names an accessor that does not exist`);
      if (p.indices !== undefined && !index(p.indices, accessors))
        problem(`mesh ${i} names indices that do not exist`);
      const counted = accessors[(p.indices ?? attributes.POSITION) as number]?.count;
      const count = typeof counted === 'number' ? counted : 0;
      return sum + (mode === 4 ? Math.floor(count / 3) : Math.max(0, count - 2));
    }, 0);
  });

  // One scene, and every node in it once: walk it from its roots.
  if (scenes.length !== 1 || (gltf.scene ?? 0) !== 0)
    problem('not exactly one scene; format 1 takes one');
  const roots = Array.isArray(scenes[0]?.nodes) ? (scenes[0]!.nodes as unknown[]) : [];
  let triangles = 0;
  const visited = new Set<number>(),
    stack = [...roots];
  while (stack.length) {
    const at = stack.pop();
    if (!index(at, nodes)) {
      problem(`the scene names node ${JSON.stringify(at)}, which does not exist`);
      break;
    }
    const i = at as number,
      node = nodes[i]!;
    if (visited.has(i)) {
      problem(`node ${i} is reached twice (a node graph must be a tree)`);
      break;
    }
    visited.add(i);
    if (node.skin !== undefined) problem(`node ${i} has a skin; format 1 models are still`);
    if (node.mesh !== undefined) {
      if (index(node.mesh, meshes)) triangles += meshTriangles[node.mesh as number]!;
      else problem(`node ${i} names a mesh that does not exist`);
    }
    if (node.children !== undefined && !Array.isArray(node.children))
      problem(`node ${i} has children that are not a list`);
    else stack.push(...((node.children as unknown[] | undefined) ?? []));
  }
  if (visited.size < nodes.length)
    problem(`${nodes.length - visited.size} node(s) outside the scene; every node is in it`);
  if (nodes.length > limits.modelNodes)
    problem(`${nodes.length} nodes, more than ${limits.modelNodes}`);
  if (triangles > limits.modelTriangles)
    problem(`${triangles} triangles, more than ${limits.modelTriangles}`);
  return check.problems.length > start ? undefined : { triangles, nodes: nodes.length };
}

/**
 * SHA-256 over every file of the pack: paths sorted by their UTF-8 bytes, each written as
 * `len(path) u32 LE · path · len(bytes) u64 LE · bytes`. The same bytes give the same hash, whatever
 * order they were read in and wherever they came from.
 */
export async function packHash(files: ReadonlyMap<string, ArrayBuffer>): Promise<string> {
  const encoder = new TextEncoder();
  const entries = [...files].map(
    ([path, data]) => [encoder.encode(path), new Uint8Array(data)] as const,
  );
  entries.sort(([a], [b]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  });
  const length = entries.reduce((sum, [path, data]) => sum + 12 + path.length + data.length, 0);
  const stream = new Uint8Array(length),
    view = new DataView(stream.buffer);
  let at = 0;
  for (const [path, data] of entries) {
    view.setUint32(at, path.length, true);
    stream.set(path, at + 4);
    at += 4 + path.length;
    view.setBigUint64(at, BigInt(data.length), true);
    stream.set(data, at + 8);
    at += 8 + data.length;
  }
  const digest = new Uint8Array(await subtle().digest('SHA-256', stream));
  return [...digest].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** A map that can only be read: no set, delete or clear to call. */
function readonlyMap<K, V>(source: Map<K, V>): ReadonlyMap<K, V> {
  const map = new Map(source);
  const view: ReadonlyMap<K, V> = {
    get size() {
      return map.size;
    },
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    forEach: (fn, self) => map.forEach((v, k) => fn.call(self, v, k, view)),
    keys: () => map.keys(),
    values: () => map.values(),
    entries: () => map.entries(),
    [Symbol.iterator]: () => map[Symbol.iterator](),
  };
  return Object.freeze(view);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
