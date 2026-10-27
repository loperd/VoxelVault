import type { BlockState } from './states.ts';

/**
 * The game's block shapes, from a state's name and properties, as blockworld can draw them: a cube
 * (a tile per side, turned in 90° steps), boxes in sixteenths (`parts`), a cross or a torch. Rotations
 * of the game's block models (`x`, `y` in its blockstates) are baked: boxes are placed, tiles turned.
 * Nothing here knows a building; textures are roles (`top`, `side`, `end`…) the mapping resolves.
 */
export type Side = 'north' | 'south' | 'east' | 'west' | 'up' | 'down';
export const SIDES: readonly Side[] = ['north', 'south', 'east', 'west', 'up', 'down'];

/** A face's tile: the first role of `roles` the mapping gives, turned `quarters`×90° clockwise. */
export interface FaceRef {
  readonly roles: readonly string[];
  readonly quarters: number;
  readonly uv?: readonly [number, number, number, number];
}
export interface Part {
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
  readonly faces?: Partial<Record<Side, FaceRef>>;
}

export type Shape =
  | { readonly kind: 'cube'; readonly faces: Readonly<Record<Side, FaceRef>> }
  | {
      readonly kind: 'parts';
      readonly faces: Readonly<Record<Side, FaceRef>>;
      readonly parts: readonly Part[];
    }
  | { readonly kind: 'cross'; readonly roles: readonly string[] }
  | { readonly kind: 'torch'; readonly roles: readonly string[] };

export type Finding =
  | {
      readonly kind: 'approximated';
      readonly aspect: 'shape' | 'material' | 'texture' | 'state' | 'block-entity';
      readonly code: string;
      readonly detail: string;
    }
  | { readonly kind: 'unsupported'; readonly code: string; readonly detail: string };

export interface Geometry {
  readonly shape?: Shape;
  readonly findings: readonly Finding[];
  /**
   * Properties the shape was not made from. Whether they change the picture is the block's own
   * question (its blockstate, import.ts), not a list of names here.
   */
  readonly unread: readonly string[];
}

/** Which roles a side of the game's unturned model takes, in order. */
const ROLES: Readonly<Record<Side, readonly string[]>> = {
  north: ['north', 'front', 'side', 'all'],
  south: ['south', 'side', 'all'],
  east: ['east', 'side', 'all'],
  west: ['west', 'side', 'all'],
  up: ['up', 'top', 'end', 'all'],
  down: ['down', 'bottom', 'end', 'all'],
};
const plain = (side: Side): FaceRef => ({ roles: ROLES[side], quarters: 0 });
const PLAIN = Object.fromEntries(SIDES.map((s) => [s, plain(s)])) as Record<Side, FaceRef>;

// ── Rotations ────────────────────────────────────────────────────────────────────────────────────
type V = readonly [number, number, number];
const NORMAL: Readonly<Record<Side, V>> = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
  up: [0, 1, 0],
  down: [0, -1, 0],
};
/**
 * Each side's tile axes as blockworld's mesher lays them (packages/blockworld/src/mesher.ts FACES:
 * u from corner 0 to 1, v — the tile's up — from corner 1 to 2), which is the game's own layout.
 */
const AXES: Readonly<Record<Side, { u: V; v: V }>> = {
  east: { u: [0, 0, -1], v: [0, 1, 0] },
  west: { u: [0, 0, 1], v: [0, 1, 0] },
  south: { u: [1, 0, 0], v: [0, 1, 0] },
  north: { u: [-1, 0, 0], v: [0, 1, 0] },
  up: { u: [1, 0, 0], v: [0, 0, -1] },
  down: { u: [1, 0, 0], v: [0, 0, 1] },
};
const same = (a: V, b: V) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const neg = (a: V): V => [-a[0], -a[1], -a[2]];
/** The game's model rotation: `x` about the x axis (up turns to north), then `y` about the vertical (north turns to east). */
function turn(p: V, x: number, y: number): V {
  let [a, b, c] = p;
  for (let i = 0; i < (((x / 90) % 4) + 4) % 4; i++) [a, b, c] = [a, c, -b];
  for (let i = 0; i < (((y / 90) % 4) + 4) % 4; i++) [a, b, c] = [-c, b, a];
  return [a + 0, b + 0, c + 0];
}
const sideOf = (n: V) => SIDES.find((s) => same(NORMAL[s], n))!;

/** Faces of a turned model (no uvlock): where each model side lands, and how far its tile turns there. */
export function turnFaces(
  faces: Readonly<Record<Side, FaceRef>>,
  x: number,
  y: number,
): Record<Side, FaceRef> {
  const out = {} as Record<Side, FaceRef>;
  for (const side of SIDES) {
    const to = sideOf(turn(NORMAL[side], x, y)),
      up = turn(AXES[side].v, x, y),
      { u, v } = AXES[to];
    const quarters = same(up, v) ? 0 : same(up, u) ? 1 : same(up, neg(v)) ? 2 : 3;
    out[to] = { ...faces[side], quarters: (faces[side].quarters + quarters) % 4 };
  }
  return out;
}

/** A box of the unturned model turned about the cell's centre (in sixteenths). */
function turnBox(part: Part, x: number, y: number): Part {
  const a = turn(part.from.map((v) => v - 8) as unknown as V, x, y),
    b = turn(part.to.map((v) => v - 8) as unknown as V, x, y);
  const from = [0, 1, 2].map((i) => Math.min(a[i]!, b[i]!) + 8) as unknown as [
    number,
    number,
    number,
  ];
  const to = [0, 1, 2].map((i) => Math.max(a[i]!, b[i]!) + 8) as unknown as [
    number,
    number,
    number,
  ];
  return {
    from,
    to,
    ...(part.faces ? { faces: turnFaces({ ...PLAIN, ...part.faces }, x, y) } : {}),
  };
}

// ── Families ─────────────────────────────────────────────────────────────────────────────────────
const FACING_Y: Readonly<Record<string, number>> = { north: 0, east: 90, south: 180, west: 270 };
type Dir = 'n' | 's' | 'e' | 'w';
const DIRS = { north: 'n', south: 's', east: 'e', west: 'w' } as const;
type Box = readonly [number, number, number, number, number, number];
const part = (b: Box, faces?: Partial<Record<Side, FaceRef>>): Part => ({
  from: [b[0], b[1], b[2]],
  to: [b[3], b[4], b[5]],
  ...(faces ? { faces } : {}),
});

// Stairs (the game's blockstates use uvlock: tiles stay put in the world, so boxes need no faces).
const flipY = (b: Box): Box => [b[0], 16 - b[4], b[2], b[3], 16 - b[1], b[5]];
const quarter = (ns: 'n' | 's', we: 'w' | 'e'): Box => [
  we === 'w' ? 0 : 8,
  8,
  ns === 'n' ? 0 : 8,
  we === 'w' ? 8 : 16,
  16,
  ns === 'n' ? 8 : 16,
];
const LEFT = { n: 'w', s: 'e', e: 'n', w: 's' } as const,
  RIGHT = { n: 'e', s: 'w', e: 's', w: 'n' } as const,
  BACK = { n: 's', s: 'n', e: 'w', w: 'e' } as const;
const corner = (a: Dir, b: Dir): Box =>
  quarter(
    (a === 'n' || a === 's' ? a : b) as 'n' | 's',
    (a === 'w' || a === 'e' ? a : b) as 'w' | 'e',
  );
const halfOn = (d: Dir): Box =>
  (
    ({
      n: [0, 8, 0, 16, 16, 8],
      s: [0, 8, 8, 16, 16, 16],
      w: [0, 8, 0, 8, 16, 16],
      e: [8, 8, 0, 16, 16, 16],
    }) as const
  )[d];
export function stairBoxes(facing: Dir, half: 'top' | 'bottom', shape: string): Box[] {
  const upper: Box[] =
    shape === 'outer_left'
      ? [corner(facing, LEFT[facing])]
      : shape === 'outer_right'
        ? [corner(facing, RIGHT[facing])]
        : shape === 'inner_left'
          ? [halfOn(facing), corner(BACK[facing], LEFT[facing])]
          : shape === 'inner_right'
            ? [halfOn(facing), corner(BACK[facing], RIGHT[facing])]
            : [halfOn(facing)];
  const boxes: Box[] = [[0, 0, 0, 16, 8, 16], ...upper];
  return half === 'top' ? boxes.map(flipY) : boxes;
}

/** Walls and fences: the post and arms towards connected sides, as the game's multipart models. */
function postBoxes(props: Readonly<Record<string, string>>, wall: boolean): Box[] {
  const boxes: Box[] = [];
  if (!wall || props.up !== 'false')
    boxes.push(wall ? [4, 0, 4, 12, 16, 12] : [6, 0, 6, 10, 16, 10]);
  for (const [side, d] of Object.entries(DIRS)) {
    const v = props[side];
    if (!v || v === 'none' || v === 'false') continue;
    // Walls: an arm to the cell's edge, 14 (low) or 16 (tall) high. Fences: two bars to 9/16 inwards.
    const [a0, a1] = wall ? [5, 11] : [7, 9],
      reach = wall ? 8 : 9;
    const span = (y0: number, y1: number): Box =>
      d === 'n'
        ? [a0, y0, 0, a1, y1, reach]
        : d === 's'
          ? [a0, y0, 16 - reach, a1, y1, 16]
          : d === 'w'
            ? [0, y0, a0, reach, y1, a1]
            : [16 - reach, y0, a0, 16, y1, a1];
    if (wall) boxes.push(span(0, v === 'tall' ? 16 : 14));
    else boxes.push(span(6, 9), span(12, 15));
  }
  return boxes;
}

/** Blocks the game draws with shapes blockworld cannot (yet): a mapping does not make them cubes. */
const UNSUPPORTED = [
  /_door$/,
  /_fence_gate$/,
  /_pane$/,
  /^glass_pane$/,
  /_bed$/,
  /_button$/,
  /_pressure_plate$/,
  /_sign$/,
  /_banner$/,
  /_carpet$/,
  /_head$/,
  /_skull$/,
  /(^|_)rail$/,
  /^ladder$/,
  /^vine$/,
  /(^|_)chest$/,
  /^chain$/,
  /^iron_bars$/,
  /_candle$/,
  /^candle$/,
  /^flower_pot$/,
  /^potted_/,
  /_wall_torch$/,
  /^wall_torch$/,
  /^lever$/,
  /^bell$/,
  /^anvil$/,
  /^cauldron$/,
  /campfire$/,
  /^scaffolding$/,
  /^lectern$/,
  /_wall_fan$/,
  /^water$/,
  /^lava$/,
  /^bubble_column$/,
  /^snow$/,
];

export interface GeometryOptions {
  /** The mapping's shape for a block the game draws as a cube or a plant. */
  readonly shape?: 'cube' | 'cross' | 'torch';
  /** The block has a front (furnace-like): `facing` turns the front about the vertical. Otherwise its top turns towards `facing` (barrel-like). */
  readonly front?: boolean;
}

export function geometry(state: BlockState, options: GeometryOptions = {}): Geometry {
  const { name, props } = state,
    findings: Finding[] = [],
    used = new Set<string>();
  const done = (shape: Shape | undefined): Geometry => ({
    ...(shape ? { shape } : {}),
    findings,
    unread: Object.keys(props).filter((k) => !used.has(k)),
  });
  const take = (...keys: string[]) => keys.forEach((k) => used.add(k));

  const bad = UNSUPPORTED.find((re) => re.test(name));
  if (bad)
    return {
      findings: [
        {
          kind: 'unsupported',
          code: 'geometry',
          detail: `the game's ${name} shape has no blockworld equivalent yet`,
        },
      ],
      unread: Object.keys(props),
    };

  if (name.endsWith('_stairs')) {
    take('facing', 'half', 'shape');
    const facing = DIRS[props.facing as keyof typeof DIRS] ?? 'n';
    return done({
      kind: 'parts',
      faces: PLAIN,
      parts: stairBoxes(
        facing,
        props.half === 'top' ? 'top' : 'bottom',
        props.shape ?? 'straight',
      ).map((b) => part(b)),
    });
  }
  if (name.endsWith('_slab')) {
    take('type');
    if (props.type === 'double') return done({ kind: 'cube', faces: PLAIN });
    return done({
      kind: 'parts',
      faces: PLAIN,
      parts: [part(props.type === 'top' ? [0, 8, 0, 16, 16, 16] : [0, 0, 0, 16, 8, 16])],
    });
  }
  if (name.endsWith('_wall') || name.endsWith('_fence')) {
    take('north', 'south', 'east', 'west', 'up');
    return done({
      kind: 'parts',
      faces: PLAIN,
      parts: postBoxes(props, name.endsWith('_wall')).map((b) => part(b)),
    });
  }
  if (name.endsWith('_trapdoor')) {
    take('facing', 'half', 'open');
    const y = FACING_Y[props.facing ?? 'north'] ?? 0,
      top = props.half === 'top';
    if (props.open === 'true') {
      // trapdoor_open, turned by facing; the upper half is the same plate turned over (x 180, y + 180),
      // which leaves it in place with its tile upside down on the broad faces.
      const flip: FaceRef = { roles: ROLES.north, quarters: top ? 2 : 0 };
      const base = part([0, 0, 13, 16, 16, 16], {
        north: flip,
        south: { ...flip, roles: ROLES.south },
      });
      return done({ kind: 'parts', faces: PLAIN, parts: [turnBox(base, 0, y)] });
    }
    // Closed: a plate whose tile turns with its facing (the game uses no uvlock for trapdoors).
    const plate = part(top ? [0, 13, 0, 16, 16, 16] : [0, 0, 0, 16, 3, 16], {
      up: plain('up'),
      down: plain('down'),
    });
    return done({ kind: 'parts', faces: PLAIN, parts: [turnBox(plate, 0, y)] });
  }
  if (name === 'lantern' || name === 'soul_lantern') {
    take('hanging');
    const lift = props.hanging === 'true' ? 1 : 0;
    // The game's lantern model and its tile layout: a 6×7 body, a 4×2 cap; the two crossed handle
    // planes are turned 45°, which parts cannot be.
    const all = (uvSide: Box4, uvEnd: Box4): Partial<Record<Side, FaceRef>> => ({
      north: { roles: ['all'], quarters: 0, uv: uvSide },
      south: { roles: ['all'], quarters: 0, uv: uvSide },
      east: { roles: ['all'], quarters: 0, uv: uvSide },
      west: { roles: ['all'], quarters: 0, uv: uvSide },
      up: { roles: ['all'], quarters: 0, uv: uvEnd },
      down: { roles: ['all'], quarters: 0, uv: uvEnd },
    });
    findings.push({
      kind: 'approximated',
      aspect: 'shape',
      code: 'lantern-handle',
      detail: 'the two crossed handle planes (turned 45°) are left out',
    });
    return done({
      kind: 'parts',
      faces: PLAIN,
      parts: [
        part([5, lift, 5, 11, 7 + lift, 11], all([0, 2, 6, 9], [0, 9, 6, 15])),
        part([6, 7 + lift, 6, 10, 9 + lift, 10], all([1, 0, 5, 2], [1, 10, 5, 14])),
      ],
    });
  }
  if (name === 'fire' || name === 'soul_fire') {
    take('north', 'south', 'east', 'west', 'up');
    findings.push({
      kind: 'approximated',
      aspect: 'shape',
      code: 'fire-planes',
      detail: "two crossed planes instead of the game's four leaning ones",
    });
    const sides = ['north', 'south', 'east', 'west', 'up'].filter((k) => props[k] === 'true');
    if (sides.length)
      findings.push({
        kind: 'approximated',
        aspect: 'shape',
        code: 'fire-sides',
        detail: `fire on ${sides.join(', ')} drawn as floor fire`,
      });
    return done({ kind: 'cross', roles: ['all'] });
  }
  if (props.axis) {
    // Pillars (logs, wood, basalt…): the game's column turned to lie along x or z.
    take('axis');
    const [x, y] = props.axis === 'x' ? [90, 90] : props.axis === 'z' ? [90, 0] : [0, 0];
    return done({ kind: 'cube', faces: turnFaces(PLAIN, x, y) });
  }
  if (props.facing && options.shape !== 'cross' && options.shape !== 'torch') {
    // Facing cubes: furnaces and the like (front towards facing), barrels and the like (top towards facing).
    take('facing');
    if (options.front)
      return done({ kind: 'cube', faces: turnFaces(PLAIN, 0, FACING_Y[props.facing] ?? 0) });
    const turns: Readonly<Record<string, readonly [number, number]>> = {
      up: [0, 0],
      down: [180, 0],
      north: [90, 0],
      south: [90, 180],
      west: [90, 270],
      east: [90, 90],
    };
    const t = turns[props.facing];
    if (!t) return done({ kind: 'cube', faces: PLAIN });
    if (props.open === 'true') {
      take('open');
      return done({
        kind: 'cube',
        faces: turnFaces({ ...PLAIN, up: { roles: ['top_open', ...ROLES.up], quarters: 0 } }, ...t),
      });
    }
    return done({ kind: 'cube', faces: turnFaces(PLAIN, ...t) });
  }
  if (options.shape === 'cross' || options.shape === 'torch')
    return done({ kind: options.shape, roles: ['side', 'all'] });
  return done({ kind: 'cube', faces: PLAIN });
}
type Box4 = readonly [number, number, number, number];
