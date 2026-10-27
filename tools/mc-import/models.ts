import { SIDES, type Side } from './geometry.ts';
import type { BlockState } from './states.ts';

/**
 * The game's blockstates and block models (a resource pack's `blockstates/*.json`, `models/block/*.json`)
 * as an oracle: which models a state draws, and the quads they make. The importer does not draw from
 * them; it checks its own result against them (import.ts), so `exact` is shown, not assumed.
 *
 * Read: `variants` (a list is the game's random pick by position: the first is taken and reported),
 * `multipart` with `when` (values `a|b`, `OR`, `AND`), parents, `#texture` variables, `elements`
 * with `from`/`to`, `rotation`, faces with `uv`, `rotation`, `tintindex`; `x`/`y` and `uvlock`.
 */
export interface Assets {
  readonly name: string;
  /** `blockstates/<name>.json`, parsed. */
  blockstate(name: string): unknown;
  /** `models/<path>.json` for `minecraft:block/stone` → `block/stone`, parsed. */
  model(path: string): unknown;
}

type V = readonly [number, number, number];
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface Placed {
  readonly model: string;
  readonly x: number;
  readonly y: number;
  readonly uvlock: boolean;
  readonly choices: number;
}
export interface Selection {
  readonly placed: readonly Placed[];
  /** Properties the blockstate looks at: the only ones that change the model. */
  readonly props: ReadonlySet<string>;
}

const placed = (apply: unknown): Placed => {
  const list = Array.isArray(apply) ? apply : [apply],
    first = list[0];
  if (!isObject(first) || typeof first.model !== 'string')
    throw new Error('blockstate: a variant without a model');
  return {
    model: first.model,
    x: Number(first.x ?? 0),
    y: Number(first.y ?? 0),
    uvlock: first.uvlock === true,
    choices: list.length,
  };
};

/** The models a state draws, by its blockstate file. Undefined when the pack has no blockstate for it. */
export function select(state: BlockState, assets: Assets): Selection | undefined {
  const file = assets.blockstate(state.name.replace(/^minecraft:/, ''));
  if (!isObject(file)) return undefined;
  const props = new Set<string>(),
    out: Placed[] = [];
  if (isObject(file.variants)) {
    for (const [key, apply] of Object.entries(file.variants)) {
      const conditions = key ? key.split(',').map((c) => c.split('=') as [string, string]) : [];
      conditions.forEach(([k]) => props.add(k));
      if (!out.length && conditions.every(([k, v]) => state.props[k] === v))
        out.push(placed(apply));
    }
  } else if (Array.isArray(file.multipart)) {
    const holds = (when: unknown): boolean => {
      if (!isObject(when)) return true;
      if (Array.isArray(when.OR)) return when.OR.some(holds);
      if (Array.isArray(when.AND)) return when.AND.every(holds);
      return Object.entries(when).every(([k, v]) =>
        String(v)
          .split('|')
          .includes(state.props[k] ?? ''),
      );
    };
    const collect = (when: unknown): void => {
      if (!isObject(when)) return;
      for (const [k, v] of Object.entries(when))
        if (k === 'OR' || k === 'AND') (v as unknown[]).forEach(collect);
        else props.add(k);
    };
    for (const part of file.multipart) {
      if (!isObject(part)) continue;
      collect(part.when);
      if (holds(part.when)) out.push(placed(part.apply));
    }
  } else return undefined;
  return { placed: out, props };
}

export interface ModelFace {
  readonly texture: string;
  readonly uv?: readonly [number, number, number, number];
  readonly rotation: number;
  readonly tintindex?: number;
}
export interface Element {
  readonly from: V;
  readonly to: V;
  readonly rotation?: { readonly angle: number; readonly axis: string };
  readonly shade: boolean;
  readonly faces: Partial<Record<Side, ModelFace>>;
}
export interface Model {
  readonly id: string;
  readonly elements: readonly Element[];
  readonly ambientOcclusion: boolean;
}

const path = (id: string) => id.replace(/^minecraft:/, '');
/** A texture reference → the tile's name in `textures/block/` (`minecraft:block/stone` → `stone`). */
const tileName = (ref: string) => path(ref).replace(/^block\//, '');

/** A model with its parents' elements and textures, every `#variable` resolved to a tile name. */
export function flatten(id: string, assets: Assets): Model {
  const textures: Record<string, string> = {};
  let elements: unknown[] | undefined, ambientOcclusion: boolean | undefined;
  for (let ref: string | undefined = id, depth = 0; ref; depth++) {
    if (depth > 16) throw new Error(`model ${id}: parents too deep`);
    const m = assets.model(path(ref));
    if (!isObject(m)) throw new Error(`model ${id}: no ${path(ref)}`);
    for (const [k, v] of Object.entries(isObject(m.textures) ? m.textures : {}))
      if (!(k in textures)) textures[k] = String(v);
    if (!elements && Array.isArray(m.elements)) elements = m.elements;
    if (ambientOcclusion === undefined && typeof m.ambientocclusion === 'boolean')
      ambientOcclusion = m.ambientocclusion;
    ref = typeof m.parent === 'string' && !m.parent.startsWith('builtin/') ? m.parent : undefined;
  }
  const resolve = (ref: string): string => {
    for (let r = ref, n = 0; n < 16; n++) {
      if (!r.startsWith('#')) return tileName(r);
      const next = textures[r.slice(1)];
      if (next === undefined) return `#${r.slice(1)}`;
      r = next;
    }
    throw new Error(`model ${id}: texture ${ref} loops`);
  };
  return {
    id,
    ambientOcclusion: ambientOcclusion ?? true,
    elements: (elements ?? []).filter(isObject).map((e) => ({
      from: e.from as V,
      to: e.to as V,
      shade: e.shade !== false,
      ...(isObject(e.rotation)
        ? { rotation: { angle: Number(e.rotation.angle ?? 0), axis: String(e.rotation.axis) } }
        : {}),
      faces: Object.fromEntries(
        Object.entries(isObject(e.faces) ? e.faces : {})
          .filter(([s, f]) => SIDES.includes(s as Side) && isObject(f))
          .map(([s, f]) => {
            const face = f as Json;
            return [
              s,
              {
                texture: resolve(String(face.texture)),
                rotation: Number(face.rotation ?? 0),
                ...(Array.isArray(face.uv)
                  ? { uv: face.uv as [number, number, number, number] }
                  : {}),
                ...(typeof face.tintindex === 'number' ? { tintindex: face.tintindex } : {}),
              },
            ];
          }),
      ),
    })),
  };
}

// ── Quads: a face as its four corners in the cell (sixteenths) and the tile pixel each shows ────────
/** Each side's tile axes, as the game lays them (and blockworld's mesher, mesher.ts FACES): u right, v the tile's up. */
export const AXES: Readonly<Record<Side, { readonly u: V; readonly v: V; readonly n: V }>> = {
  east: { u: [0, 0, -1], v: [0, 1, 0], n: [1, 0, 0] },
  west: { u: [0, 0, 1], v: [0, 1, 0], n: [-1, 0, 0] },
  south: { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  north: { u: [-1, 0, 0], v: [0, 1, 0], n: [0, 0, -1] },
  up: { u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] },
  down: { u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
};
/** The game's UV for a face that gives none: the part of the tile the box covers (uvlock looks the same). */
export function positionalUv(side: Side, f: V, t: V): [number, number, number, number] {
  switch (side) {
    case 'down':
      return [f[0], 16 - t[2], t[0], 16 - f[2]];
    case 'up':
      return [f[0], f[2], t[0], t[2]];
    case 'north':
      return [16 - t[0], 16 - t[1], 16 - f[0], 16 - f[1]];
    case 'south':
      return [f[0], 16 - t[1], t[0], 16 - f[1]];
    case 'west':
      return [f[2], 16 - t[1], t[2], 16 - f[1]];
    case 'east':
      return [16 - t[2], 16 - t[1], 16 - f[2], 16 - f[1]];
  }
}

export interface Quad {
  readonly side: Side;
  /** The box the face belongs to, in the cell (sixteenths). */
  readonly box: readonly [number, number, number, number, number, number];
  readonly tile: string;
  /** Its corners in the cell (sixteenths): top left, top right, bottom right, bottom left as the tile lies on it. */
  readonly points: readonly V[];
  /** The tile pixel at each corner (0..16 from the top left of the unturned tile). */
  readonly uvs: readonly (readonly [number, number])[];
  readonly tint?: number | string;
}

const r6 = (n: number) => Math.round(n * 1e4) / 1e4 + 0;
/** The four corners of a box's face, top-left, top-right, bottom-right, bottom-left as the tile lies on it. */
function faceCorners(side: Side, f: V, t: V): V[] {
  const { u, v, n } = AXES[side];
  const pick = (dir: V, high: boolean) =>
    dir.map((d, i) => (d === 0 ? undefined : d > 0 === high ? t[i]! : f[i]!));
  const plane = n.map((d, i) => (d === 0 ? undefined : d > 0 ? t[i]! : f[i]!));
  const corner = (uHigh: boolean, vHigh: boolean): V =>
    [0, 1, 2].map((i) => plane[i] ?? pick(u, uHigh)[i] ?? pick(v, vHigh)[i]!) as unknown as V;
  return [corner(false, true), corner(true, true), corner(true, false), corner(false, false)];
}
/** A pixel of a tile turned `q`×90° clockwise → the same pixel of the unturned tile. */
const unturn = ([x, y]: readonly [number, number], q: number): [number, number] => {
  let p: [number, number] = [x, y];
  for (let i = 0; i < ((q % 4) + 4) % 4; i++) p = [p[1], 16 - p[0]];
  return p;
};

/**
 * A face of a box: `uv` (or the positional one) on the tile turned `quarters` clockwise, turned on
 * the face `rotation` degrees clockwise (the game's face rotation).
 */
export function quad(
  side: Side,
  f: V,
  t: V,
  tile: string,
  uv: readonly [number, number, number, number] | undefined,
  quarters = 0,
  rotation = 0,
  tint?: number | string,
): Quad {
  const [u0, v0, u1, v1] = uv ?? positionalUv(side, f, t);
  const corners = faceCorners(side, f, t),
    uvs: [number, number][] = [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ];
  const shift = (((rotation / 90) % 4) + 4) % 4;
  const shown = corners.map((_, k) => unturn(uvs[(k - shift + 4) % 4]!, quarters));
  return {
    side,
    box: [...f, ...t].map(r6) as unknown as Quad['box'],
    tile,
    points: corners,
    uvs: shown,
    ...(tint !== undefined ? { tint } : {}),
  };
}

/** The game's model turn: `x` about the x axis (up turns to north), then `y` about the vertical (north turns to east). */
function turn(p: V, x: number, y: number): V {
  let [a, b, c] = p;
  for (let i = 0; i < (((x / 90) % 4) + 4) % 4; i++) [a, b, c] = [a, c, -b];
  for (let i = 0; i < (((y / 90) % 4) + 4) % 4; i++) [a, b, c] = [-c, b, a];
  return [a + 0, b + 0, c + 0];
}
const about = (p: V, x: number, y: number): V =>
  turn(p.map((n) => n - 8) as unknown as V, x, y).map((n) => n + 8) as unknown as V;
const sideOf = (n: V): Side => SIDES.find((s) => AXES[s].n.every((d, i) => d === n[i]))!;

export interface Drawn {
  readonly quads: readonly Quad[];
  /** What the quads cannot carry: rotated elements, unshaded ones, a random pick. */
  readonly notes: readonly { readonly code: string; readonly detail: string }[];
}

/** The quads the game draws for a state's models, turned and uv-locked as its blockstate says. */
export function drawn(selection: Selection, assets: Assets): Drawn {
  const quads: Quad[] = [],
    notes: { code: string; detail: string }[] = [];
  for (const p of selection.placed) {
    const model = flatten(p.model, assets);
    if (p.choices > 1)
      notes.push({
        code: 'random-variant',
        detail: `the game picks one of ${p.choices} variants of ${path(p.model)} by position; the first is compared`,
      });
    if (!model.elements.length)
      notes.push({
        code: 'no-elements',
        detail: `${path(p.model)} has no elements: the game draws it another way (a block entity, a fluid)`,
      });
    for (const e of model.elements) {
      if (e.rotation && e.rotation.angle !== 0) {
        notes.push({
          code: 'rotated-element',
          detail: `${path(p.model)}: an element turned ${e.rotation.angle}° about ${e.rotation.axis}`,
        });
        continue;
      }
      if (!e.shade)
        notes.push({
          code: 'unshaded',
          detail: `${path(p.model)}: an element drawn without side shading`,
        });
      const a = about(e.from, p.x, p.y),
        b = about(e.to, p.x, p.y);
      const f: V = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
        t: V = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
      for (const [modelSide, face] of Object.entries(e.faces) as [Side, ModelFace][]) {
        const side = sideOf(turn(AXES[modelSide].n, p.x, p.y));
        const tint = face.tintindex;
        if (p.uvlock && (p.x || p.y)) {
          // uvlock keeps the tile still in the world: the face shows the part of the tile its place covers.
          if (
            (face.uv && face.uv.some((n, i) => n !== positionalUv(modelSide, e.from, e.to)[i])) ||
            face.rotation
          )
            notes.push({
              code: 'uvlock-uv',
              detail: `${path(p.model)}: uvlock on a face with its own uv; compared as positional`,
            });
          quads.push(quad(side, f, t, face.texture, undefined, 0, 0, tint));
          continue;
        }
        // Without uvlock the tile turns with the face: the model-space quad, its corners turned.
        const q = quad(modelSide, e.from, e.to, face.texture, face.uv, 0, face.rotation, tint);
        quads.push({
          ...q,
          side,
          box: [...f, ...t].map(r6) as unknown as Quad['box'],
          points: q.points.map((point) => about(point, p.x, p.y)),
        });
      }
    }
  }
  return { quads, notes };
}

// ── Probe: a model as pack parts, without changing blockworld ───────────────────────────────────────
export interface ProbeFace {
  readonly tile: string;
  readonly quarters: number;
  readonly uv: readonly [number, number, number, number];
}
export interface ProbePart {
  readonly from: V;
  readonly to: V;
  readonly faces: Partial<Record<Side, ProbeFace>>;
}
export interface Probe {
  readonly parts?: readonly ProbePart[];
  readonly problems: readonly string[];
}

/**
 * Not used by the importer: the smallest model → `parts` conversion, to show which of the game's
 * models a pack can already carry. A face's own rotation becomes a turned tile copy and a UV on it;
 * a face the model leaves out cannot be left out (a part has six) and is named; a turned element
 * (22.5°, 45°) cannot be a part at all.
 */
export function probeParts(drawnQuads: readonly Quad[]): Probe {
  const problems: string[] = [],
    byBox = new Map<string, { from: V; to: V; faces: Partial<Record<Side, ProbeFace>> }>();
  for (const q of drawnQuads) {
    const key = q.box.join(','),
      part = byBox.get(key) ?? {
        from: q.box.slice(0, 3) as unknown as V,
        to: q.box.slice(3) as unknown as V,
        faces: {},
      };
    if (q.tint !== undefined)
      problems.push(`${q.side} of ${key}: tinted (a pack bakes a tint into a tile copy)`);
    // The corners' pixels on a tile turned `quarters`: they must form the rectangle [u0,v0]–[u1,v1] in order.
    const turnAhead = ([x, y]: readonly [number, number], n: number): [number, number] => {
      let p: [number, number] = [x, y];
      for (let i = 0; i < n; i++) p = [16 - p[1], p[0]];
      return p;
    };
    let face: ProbeFace | undefined;
    for (let quarters = 0; quarters < 4 && !face; quarters++) {
      const [tl, tr, br, bl] = q.uvs.map((uv) => turnAhead(uv, quarters)) as [
        [number, number],
        [number, number],
        [number, number],
        [number, number],
      ];
      if (tl[1] === tr[1] && bl[1] === br[1] && tl[0] === bl[0] && tr[0] === br[0])
        face = { tile: q.tile, quarters, uv: [tl[0], tl[1], br[0], br[1]] };
    }
    if (!face) {
      problems.push(`${q.side} of ${key}: no turn of the tile lays its pixels as a rectangle`);
      continue;
    }
    if (part.faces[q.side])
      problems.push(`${q.side} of ${key}: two tiles on one face (an overlay)`);
    part.faces[q.side] = face;
    byBox.set(key, part);
  }
  for (const [key, part] of byBox) {
    // A flat element's edges have no area: leaving them out changes nothing.
    const absent = SIDES.filter(
      (s) =>
        !part.faces[s] &&
        [0, 1, 2]
          .filter((i) => i !== AXES[s].n.findIndex((d) => d !== 0))
          .every((i) => part.to[i]! > part.from[i]!),
    );
    if (absent.length)
      problems.push(
        `${key}: the model leaves out ${absent.join(', ')}; a part draws all six (seen or not: verify.ts)`,
      );
    if (part.from.some((v, i) => v < 0 || part.to[i]! > 16))
      problems.push(`${key}: outside the cell`);
  }
  if (byBox.size > 32) problems.push(`${byBox.size} boxes; a pack block takes 32`);
  return { parts: [...byBox.values()], problems };
}
