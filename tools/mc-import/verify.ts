import { SIDES, type Finding, type Side } from './geometry.ts';
import { quad, type Drawn, type Quad } from './models.ts';

/**
 * The importer's block against the game's model (models.ts): the same boxes, and on every face the
 * same tile, the same pixels at the same corners and the same tint. What differs is a finding; what
 * is the same is shown to be, which is what `exact` means in the report.
 */
export interface Own {
  /** The pack's block definition, as import.ts writes it. */
  readonly definition: Readonly<Record<string, unknown>>;
  /** A pack tile → the resource tile it was made from and how far it was turned. */
  readonly source: (packTile: string) => {
    readonly name: string;
    readonly quarters: number;
    readonly tint?: string;
  };
}

type Box = readonly [number, number, number, number, number, number];
interface PartJson {
  from: [number, number, number];
  to: [number, number, number];
  faces?: Partial<Record<Side, { texture?: string; uv?: [number, number, number, number] }>>;
}

/** The quads a pack block draws (cube or parts); undefined for the models drawn their own way (cross, torch). */
export function ownQuads({ definition, source }: Own): Quad[] | undefined {
  const model = (definition.model as string | undefined) ?? 'cube',
    textures = definition.textures as Record<string, string>;
  const tileOf = (side: Side) => textures[side] ?? textures.side ?? textures.all;
  const parts: PartJson[] =
    model === 'cube'
      ? [{ from: [0, 0, 0], to: [16, 16, 16] }]
      : model === 'parts'
        ? (definition.parts as PartJson[])
        : [];
  if (!parts.length) return undefined;
  const quads: Quad[] = [];
  for (const part of parts)
    for (const side of SIDES) {
      const own = part.faces?.[side],
        s = source(own?.texture ?? tileOf(side)!);
      quads.push(quad(side, part.from, part.to, s.name, own?.uv, s.quarters, 0, s.tint));
    }
  return quads;
}

export interface Verdict {
  readonly shape: Finding[];
  readonly material: Finding[];
  /** What the comparison could not show either way, by aspect. */
  readonly unverified: { readonly shape: string[]; readonly material: string[] };
}

type V = readonly [number, number, number];
const EPS = 1e-3,
  round = (n: number) => Math.round(n * 1e3) / 1e3 + 0;
const AXIS: Readonly<Record<Side, number>> = {
  east: 0,
  west: 0,
  up: 1,
  down: 1,
  south: 2,
  north: 2,
};
const OUT: Readonly<Record<Side, number>> = {
  east: 1,
  west: -1,
  up: 1,
  down: -1,
  south: 1,
  north: -1,
};
const inside = (p: V, boxes: readonly Box[]) =>
  boxes.some((b) => [0, 1, 2].every((i) => p[i]! > b[i]! + EPS / 2 && p[i]! < b[i + 3]! - EPS / 2));

interface Sample {
  readonly key: string;
  readonly area: number;
  readonly look: string;
  readonly tint: boolean;
}
/**
 * A model's visible surface, cut on a grid every model's corners fall on: for each piece of each
 * face, where it is, the tile pixel at its middle and whether it is tinted. A piece another box of
 * the same model stands right in front of is hidden and left out. So two models are compared by what
 * shows, however their boxes are cut.
 */
function surface(
  quads: readonly Quad[],
  grid: readonly (readonly number[])[],
): Map<string, Sample[]> {
  const boxes = [...new Set(quads.map((q) => q.box.join(',')))]
    .map((k) => k.split(',').map(Number) as unknown as Box)
    .filter((b) => b[0] < b[3] && b[1] < b[4] && b[2] < b[5]);
  const out = new Map<string, Sample[]>();
  for (const q of quads) {
    const n = AXIS[q.side],
      [a, b] = [0, 1, 2].filter((i) => i !== n) as [number, number];
    const [tl, tr, , bl] = q.points as [V, V, V, V],
      [uvTl, uvTr, , uvBl] = q.uvs as [
        [number, number],
        [number, number],
        [number, number],
        [number, number],
      ];
    const lo = (i: number) => Math.min(...q.points.map((p) => p[i]!)),
      hi = (i: number) => Math.max(...q.points.map((p) => p[i]!));
    const cuts = (i: number) => grid[i]!.filter((v) => v >= lo(i) - EPS && v <= hi(i) + EPS);
    const ca = cuts(a),
      cb = cuts(b);
    for (let i = 0; i + 1 < ca.length; i++)
      for (let j = 0; j + 1 < cb.length; j++) {
        const c = [0, 0, 0] as [number, number, number];
        c[n] = tl[n]!;
        c[a] = (ca[i]! + ca[i + 1]!) / 2;
        c[b] = (cb[j]! + cb[j + 1]!) / 2;
        const front = [...c] as [number, number, number];
        front[n] = front[n]! + OUT[q.side] * EPS;
        if (inside(front, boxes)) continue;
        // The tile pixels at the piece's corners, in the world's order (a turned or mirrored tile shows
        // the same middle, not the same corners); the corners are a rectangle, so a pixel is affine in its place.
        const pixel = (p: V) => {
          const along = (from: V, to: V) => {
            const d = [0, 1, 2].map((k) => to[k]! - from[k]!),
              l = d.reduce((x, y) => x + y * y, 0);
            return l ? [0, 1, 2].reduce((x, k) => x + (p[k]! - from[k]!) * d[k]!, 0) / l : 0;
          };
          const s = along(tl, tr),
            t = along(tl, bl);
          return [0, 1]
            .map((k) => round(uvTl[k]! + s * (uvTr[k]! - uvTl[k]!) + t * (uvBl[k]! - uvTl[k]!)))
            .join(',');
        };
        const corner = (x: number, y: number): V => {
          const p = [...c] as [number, number, number];
          p[a] = ca[i + x]!;
          p[b] = cb[j + y]!;
          return p;
        };
        const key = `${q.side} ${c.map(round).join(',')}`,
          list = out.get(key) ?? [];
        list.push({
          key,
          area: (ca[i + 1]! - ca[i]!) * (cb[j + 1]! - cb[j]!),
          look: `${q.tile}@${[corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)].map(pixel).join(' ')}`,
          tint: q.tint !== undefined,
        });
        out.set(key, list);
      }
  }
  return out;
}
/** The solid cells of a model on the grid (its boxes with volume). */
function volume(quads: readonly Quad[], grid: readonly (readonly number[])[]): Set<string> {
  const boxes = [...new Set(quads.map((q) => q.box.join(',')))].map(
    (k) => k.split(',').map(Number) as unknown as Box,
  );
  const cells = new Set<string>(),
    [gx, gy, gz] = grid as [number[], number[], number[]];
  for (let i = 0; i + 1 < gx.length; i++)
    for (let j = 0; j + 1 < gy.length; j++)
      for (let k = 0; k + 1 < gz.length; k++) {
        const c: V = [
          (gx[i]! + gx[i + 1]!) / 2,
          (gy[j]! + gy[j + 1]!) / 2,
          (gz[k]! + gz[k + 1]!) / 2,
        ];
        if (inside(c, boxes)) cells.add(c.map(round).join(','));
      }
  return cells;
}

/** Own quads against the game's: shape findings (solid, visible faces), material findings (tile, pixels, tint). */
export function compare(own: readonly Quad[], game: Drawn): Verdict {
  const shape: Finding[] = [],
    material: Finding[] = [],
    unverified = { shape: [] as string[], material: [] as string[] };
  const grid = [0, 1, 2].map((i) =>
    [...new Set([...own, ...game.quads].flatMap((q) => q.points.map((p) => round(p[i]!))))].sort(
      (x, y) => x - y,
    ),
  );
  const ownSolid = volume(own, grid),
    gameSolid = volume(game.quads, grid);
  const solidDiff =
    [...gameSolid].filter((c) => !ownSolid.has(c)).length +
    [...ownSolid].filter((c) => !gameSolid.has(c)).length;
  if (solidDiff)
    shape.push({
      kind: 'approximated',
      aspect: 'shape',
      code: 'model-volume',
      detail: `the solid differs from the game's model in ${solidDiff} grid cells`,
    });
  const mine = surface(own, grid),
    theirs = surface(game.quads, grid);
  const area = (list: Sample[] | undefined) => list?.[0]?.area ?? 0;
  let missing = 0,
    extra = 0,
    tile = 0,
    pixels = 0,
    tintMissing = 0,
    tintExtra = 0,
    overlay = 0,
    total = 0;
  let overlayTile = '';
  for (const [key, g] of theirs) {
    const o = mine.get(key),
      a = area(g);
    total += a;
    if (!o) {
      missing += a;
      continue;
    }
    if (g.length > o.length) {
      overlay += a;
      overlayTile = g[1]!.look.split('@')[0]!;
    }
    const [gl, ol] = [g[0]!, o[0]!];
    if (gl.look.split('@')[0] !== ol.look.split('@')[0]) tile += a;
    else if (gl.look !== ol.look) pixels += a;
    if (gl.tint && !ol.tint) tintMissing += a;
    if (!gl.tint && ol.tint) tintExtra += a;
  }
  for (const [key, o] of mine) if (!theirs.has(key)) extra += area(o);
  const px = (n: number) => `${round(n)} px² of ${round(total)}`;
  if (missing)
    shape.push({
      kind: 'approximated',
      aspect: 'shape',
      code: 'surface-missing',
      detail: `${px(missing)} of the game's visible surface not drawn`,
    });
  if (extra)
    shape.push({
      kind: 'approximated',
      aspect: 'shape',
      code: 'surface-extra',
      detail: `${round(extra)} px² of visible surface drawn that the game's model does not have`,
    });
  if (tile)
    material.push({
      kind: 'approximated',
      aspect: 'material',
      code: 'model-tile',
      detail: `${px(tile)} show another tile than the game's model`,
    });
  if (pixels)
    material.push({
      kind: 'approximated',
      aspect: 'material',
      code: 'model-uv',
      detail: `${px(pixels)} show the right tile, but other pixels of it or turned another way`,
    });
  if (overlay)
    material.push({
      kind: 'approximated',
      aspect: 'material',
      code: 'overlay',
      detail: `${px(overlay)} carry a second, overlaid tile in the game (${overlayTile}); one is drawn`,
    });
  if (tintMissing)
    material.push({
      kind: 'approximated',
      aspect: 'material',
      code: 'tint-missing',
      detail: `${px(tintMissing)} the game tints are drawn untinted`,
    });
  if (tintExtra)
    material.push({
      kind: 'approximated',
      aspect: 'material',
      code: 'tint-extra',
      detail: `${px(tintExtra)} tinted that the game draws untinted`,
    });
  for (const n of game.notes) {
    const finding = { kind: 'approximated' as const, code: n.code, detail: n.detail };
    if (n.code === 'uvlock-uv') unverified.material.push(n.detail);
    else if (n.code === 'no-elements') unverified.shape.push(n.detail);
    else if (n.code === 'random-variant' || n.code === 'unshaded')
      material.push({ ...finding, aspect: 'material' });
    else shape.push({ ...finding, aspect: 'shape' });
  }
  return { shape, material, unverified };
}
