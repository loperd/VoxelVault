import type { BlockBox, BlockDefinition } from '../../../../../packages/blockworld/src/index.ts';

/**
 * Minecraft block states (as a schematic names them: `minecraft:spruce_stairs[facing=west,half=top,…]`)
 * → blockworld definitions, for the import experiment. Nothing is replaced silently: every state gets
 * a verdict, and the scene and the compatibility report both read it.
 * - `exact`: our atlas has the block's own tile and the shape is the game's.
 * - `texture`: the shape is the game's, the tile a named stand-in (`stand` — the atlas has no such tile).
 * - `shape`: drawn with a simpler shape than the game's (`lost` says what is lost).
 * - `missing`: not drawn at all; the scene marks the cell.
 */
export type Verdict = 'exact' | 'texture' | 'shape' | 'missing';
export interface Mapped {
  readonly definition?: BlockDefinition;
  readonly verdict: Verdict;
  /** The tile drawn instead of the block's own, when it is a stand-in. */
  readonly stand?: string;
  /** States, details or behaviour that do not survive. */
  readonly lost: readonly string[];
}

/** Tiles our atlas paints (packages/blockworld/src/atlas.ts) — anything else is a stand-in. */
const OWN = new Set([
  'stone',
  'cobblestone',
  'stone_bricks',
  'mossy_stone_bricks',
  'deepslate',
  'deepslate_bricks',
  'deepslate_tiles',
  'dirt',
  'grass_top',
  'grass_side',
  'birch_leaves',
  'oak_leaves',
  'oak_planks',
  'oak_log',
  'oak_log_top',
  'birch_log',
  'birch_log_top',
  'glowstone',
  'obsidian',
  'calcite',
  'sand',
  'gravel',
  'lava',
  'torch',
  'chain',
  'soul_lantern',
  'candle',
  'reinforced_deepslate',
  'sculk',
]);

/** Material → [our tile, is it the block's own]. Stand-ins chosen by colour and value, named in the report. */
const MATERIAL: Readonly<Record<string, string>> = {
  stone_brick: 'stone_bricks',
  stone_bricks: 'stone_bricks',
  mossy_stone_bricks: 'mossy_stone_bricks',
  cobblestone: 'cobblestone',
  deepslate_bricks: 'deepslate_bricks',
  deepslate_tile: 'deepslate_tiles',
  deepslate_tiles: 'deepslate_tiles',
  dirt: 'dirt',
  birch_leaves: 'birch_leaves',
  // Stand-ins.
  cracked_stone_bricks: 'stone_bricks',
  blackstone: 'deepslate',
  polished_blackstone: 'deepslate_tiles',
  cracked_polished_blackstone_bricks: 'deepslate_bricks',
  polished_deepslate: 'deepslate_tiles',
  cobbled_deepslate: 'deepslate',
  polished_diorite: 'calcite',
  polished_andesite: 'stone',
  netherrack: 'lava',
  spruce: 'oak_planks',
  dark_oak: 'oak_planks',
  spruce_planks: 'oak_planks',
  spruce_wood: 'oak_log',
  stripped_spruce_wood: 'oak_log',
  spruce_leaves: 'oak_leaves',
  shroomlight: 'glowstone',
  barrel: 'oak_planks',
};
const OWN_MATERIAL = new Set([
  'stone_brick',
  'stone_bricks',
  'mossy_stone_bricks',
  'cobblestone',
  'deepslate_bricks',
  'deepslate_tile',
  'deepslate_tiles',
  'dirt',
  'birch_leaves',
]);

export function parseState(state: string): {
  name: string;
  props: Readonly<Record<string, string>>;
} {
  const [, name = state, list = ''] =
    /^(?:minecraft:)?([a-z0-9_]+)(?:\[(.*)\])?$/.exec(state) ?? [];
  return {
    name,
    props: Object.fromEntries(
      list ? list.split(',').map((p) => p.split('=') as [string, string]) : [],
    ),
  };
}

// Boxes in sixteenths, [x0, y0, z0, x1, y1, z1]; n −z, s +z, w −x, e +x (as the game's facing).
const flipY = (b: BlockBox): BlockBox => [b[0], 16 - b[4], b[2], b[3], 16 - b[1], b[5]];
/** The quarter (8×8 in plan) on the given corner, upper half. */
const quarter = (ns: 'n' | 's', we: 'w' | 'e'): BlockBox => [
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
const DIRS = { north: 'n', south: 's', east: 'e', west: 'w' } as const;
type Dir = 'n' | 's' | 'e' | 'w';
const corner = (a: Dir, b: Dir): BlockBox =>
  quarter(
    (a === 'n' || a === 's' ? a : b) as 'n' | 's',
    (a === 'w' || a === 'e' ? a : b) as 'w' | 'e',
  );
const halfOn = (d: Dir): BlockBox =>
  (
    ({
      n: [0, 8, 0, 16, 16, 8],
      s: [0, 8, 8, 16, 16, 16],
      w: [0, 8, 0, 8, 16, 16],
      e: [8, 8, 0, 16, 16, 16],
    }) as const
  )[d];

/** The game's stairs: a slab and the upper part — half, a quarter (outer) or three quarters (inner) — towards `facing`. */
export function stairBoxes(facing: Dir, half: 'top' | 'bottom', shape: string): BlockBox[] {
  const upper: BlockBox[] =
    shape === 'outer_left'
      ? [corner(facing, LEFT[facing])]
      : shape === 'outer_right'
        ? [corner(facing, RIGHT[facing])]
        : shape === 'inner_left'
          ? [halfOn(facing), corner(BACK[facing], LEFT[facing])]
          : shape === 'inner_right'
            ? [halfOn(facing), corner(BACK[facing], RIGHT[facing])]
            : [halfOn(facing)];
  const boxes: BlockBox[] = [[0, 0, 0, 16, 8, 16], ...upper];
  return half === 'top' ? boxes.map(flipY) : boxes;
}

/** Walls and fences: a post and arms towards the sides that connect (`low`/`tall` for walls, `true` for fences). */
function postBoxes(props: Readonly<Record<string, string>>, wall: boolean): BlockBox[] {
  const boxes: BlockBox[] = [];
  if (!wall || props.up !== 'false')
    boxes.push(wall ? [4, 0, 4, 12, 16, 12] : [6, 0, 6, 10, 16, 10]);
  for (const [side, d] of Object.entries(DIRS)) {
    const v = props[side];
    if (!v || v === 'none' || v === 'false') continue;
    const [a0, a1] = wall ? [5, 11] : [7, 9];
    const span = (y0: number, y1: number): BlockBox =>
      d === 'n'
        ? [a0, y0, 0, a1, y1, 8]
        : d === 's'
          ? [a0, y0, 8, a1, y1, 16]
          : d === 'w'
            ? [0, y0, a0, 8, y1, a1]
            : [8, y0, a0, 16, y1, a1];
    if (wall) boxes.push(span(0, v === 'tall' ? 16 : 14));
    else boxes.push(span(6, 9), span(12, 15));
  }
  return boxes;
}

function trapdoorBoxes(props: Readonly<Record<string, string>>): BlockBox[] {
  if (props.open !== 'true')
    return [props.half === 'top' ? [0, 13, 0, 16, 16, 16] : [0, 0, 0, 16, 3, 16]];
  // Open: against the side opposite its facing.
  return [
    (
      {
        n: [0, 0, 13, 16, 16, 16],
        s: [0, 0, 0, 16, 16, 3],
        w: [13, 0, 0, 16, 16, 16],
        e: [0, 0, 0, 3, 16, 16],
      } as const
    )[DIRS[props.facing as keyof typeof DIRS] ?? 'n'],
  ];
}

/** One state → its blockworld block (one definition per distinct state; its name is the state). */
export function mapState(state: string): Mapped {
  const { name, props } = parseState(state);
  if (name === 'air' || name === 'cave_air' || name === 'void_air')
    return { verdict: 'exact', lost: [] };
  const lost: string[] = [];
  if (props.waterlogged === 'true') lost.push('waterlogged');
  const material = (key: string) => {
    const tile = MATERIAL[key];
    return tile ? { tile, own: OWN_MATERIAL.has(key) && OWN.has(tile) } : undefined;
  };
  const out = (
    definition: Omit<BlockDefinition, 'name'>,
    tile: string,
    own: boolean,
    extra: string[] = [],
    shape = false,
  ): Mapped => ({
    definition: { name: state, ...definition },
    verdict: shape ? 'shape' : own ? 'exact' : 'texture',
    ...(own ? {} : { stand: tile }),
    lost: [...lost, ...extra],
  });

  for (const [suffix, kind] of [
    ['_stairs', 'stairs'],
    ['_slab', 'slab'],
    ['_wall', 'wall'],
    ['_fence', 'fence'],
    ['_trapdoor', 'trapdoor'],
  ] as const) {
    if (!name.endsWith(suffix)) continue;
    const m = material(name.slice(0, -suffix.length));
    if (!m) return { verdict: 'missing', lost: [`no material for ${name}`] };
    const boxes =
      kind === 'stairs'
        ? stairBoxes(
            DIRS[props.facing as keyof typeof DIRS] ?? 'n',
            props.half === 'top' ? 'top' : 'bottom',
            props.shape ?? 'straight',
          )
        : kind === 'slab'
          ? props.type === 'double'
            ? [[0, 0, 0, 16, 16, 16] as BlockBox]
            : props.type === 'top'
              ? [[0, 8, 0, 16, 16, 16] as BlockBox]
              : [[0, 0, 0, 16, 8, 16] as BlockBox]
          : kind === 'trapdoor'
            ? trapdoorBoxes(props)
            : postBoxes(props, kind === 'wall');
    return out(
      { model: 'boxes', textures: { all: m.tile }, boxes },
      m.tile,
      m.own,
      kind === 'trapdoor' ? ['trapdoor cut-outs (drawn as a solid plate)'] : [],
    );
  }

  switch (name) {
    case 'grass_block':
      return out(
        { textures: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' } },
        'grass_top',
        true,
        props.snowy === 'true' ? ['snowy'] : [],
      );
    case 'spruce_leaves':
    case 'birch_leaves': {
      const m = material(name)!;
      return out({ textures: { all: m.tile }, transparent: true, cutout: true }, m.tile, m.own, [
        'leaf distance/persistence (no decay here)',
      ]);
    }
    case 'spruce_wood':
    case 'stripped_spruce_wood':
      return out({ textures: { all: 'oak_log' } }, 'oak_log', false, [
        'axis (bark is the same on all sides)',
      ]);
    case 'barrel':
      return out({ textures: { all: 'oak_planks' } }, 'oak_planks', false, [
        'barrel lid and hoops',
        'facing',
        'its inventory (block entity)',
      ]);
    case 'shroomlight':
      return out({ textures: { all: 'glowstone' }, light: 15 }, 'glowstone', false);
    case 'lantern': {
      const hanging = props.hanging === 'true';
      const boxes: BlockBox[] = hanging
        ? [
            [5, 1, 5, 11, 8, 11],
            [6, 8, 6, 10, 10, 10],
            [7, 10, 7, 9, 16, 9],
          ]
        : [
            [5, 0, 5, 11, 7, 11],
            [6, 7, 6, 10, 9, 10],
          ];
      return out(
        { model: 'boxes', textures: { all: 'candle' }, boxes, light: 15 },
        'candle',
        false,
        ['lantern frame and glass (one warm tile)'],
      );
    }
    case 'fire':
      return out(
        { model: 'cross', textures: { all: 'lava' }, light: 15 },
        'lava',
        false,
        ['animated flame', 'per-side fire'],
        false,
      );
    case 'black_stained_glass':
    case 'red_stained_glass':
    case 'orange_stained_glass':
    case 'yellow_stained_glass': {
      // No glass in the atlas and no tinted transparency: an opaque cube of the nearest colour.
      const tile = name.startsWith('black') ? 'obsidian' : 'lava';
      return {
        definition: { name: state, textures: { all: tile } },
        verdict: 'shape',
        stand: tile,
        lost: ['transparency', 'glass colour (red/orange/yellow all one tile)'],
      };
    }
  }
  const m = material(name);
  if (m)
    return out(
      { textures: { all: m.tile } },
      m.tile,
      m.own,
      name.startsWith('cracked_') ? ['cracks'] : [],
    );
  return { verdict: 'missing', lost: [`unknown block ${name}`] };
}
