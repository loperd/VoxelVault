import { Group } from 'three';
import {
  BlockRegistry,
  BlockWorld,
  blockAtlas,
  computeLight,
  meshWorld,
  worldMeshes,
  type BlockDefinition,
  type MeshOptions,
} from '../../../../../packages/blockworld/src/index.ts';

/**
 * The art lab's palette: every block the atlas can draw, so a candidate scene is limited by its idea
 * and not by a registry. Same rules as the game's worlds: light comes from the sky and from blocks.
 */
export const BLOCKS = new BlockRegistry([
  { name: 'grass', textures: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' } },
  { name: 'dirt', textures: { all: 'dirt' } },
  { name: 'stone', textures: { all: 'stone' } },
  { name: 'cobblestone', textures: { all: 'cobblestone' } },
  { name: 'stone_bricks', textures: { all: 'stone_bricks' } },
  { name: 'mossy_stone_bricks', textures: { all: 'mossy_stone_bricks' } },
  { name: 'deepslate', textures: { all: 'deepslate' } },
  { name: 'gravel', textures: { all: 'gravel' } },
  { name: 'sand', textures: { all: 'sand' } },
  { name: 'snow', textures: { all: 'snow' } },
  { name: 'oak_log', textures: { side: 'oak_log', top: 'oak_log_top' } },
  { name: 'oak_planks', textures: { all: 'oak_planks' } },
  { name: 'oak_leaves', textures: { all: 'oak_leaves' }, transparent: true, cutout: true },
  { name: 'birch_log', textures: { side: 'birch_log', top: 'birch_log_top' } },
  { name: 'birch_leaves', textures: { all: 'birch_leaves' }, transparent: true, cutout: true },
  { name: 'obsidian', textures: { all: 'obsidian' } },
  { name: 'gold_ore', textures: { all: 'gold_ore' } },
  { name: 'lava', textures: { all: 'lava' }, light: 15 },
  { name: 'glowstone', textures: { all: 'glowstone' }, light: 15 },
  { name: 'torch', model: 'torch', textures: { all: 'torch' }, light: 14 },
  { name: 'poppy', model: 'cross', textures: { all: 'poppy' } },
  { name: 'dandelion', model: 'cross', textures: { all: 'dandelion' } },
  { name: 'tall_grass', model: 'cross', textures: { all: 'tall_grass' } },
  { name: 'water', model: 'liquid', textures: { all: 'water' } },
  // The ancient city's palette: dressed deepslate, the frame's lining, sculk, soul light.
  { name: 'deepslate_bricks', textures: { all: 'deepslate_bricks' } },
  { name: 'deepslate_tiles', textures: { all: 'deepslate_tiles' } },
  { name: 'reinforced_deepslate', textures: { all: 'reinforced_deepslate' } },
  { name: 'sculk', textures: { all: 'sculk' } },
  {
    name: 'deepslate_brick_slab',
    model: 'boxes',
    textures: { all: 'deepslate_bricks' },
    boxes: [[0, 0, 0, 16, 8, 16]],
  },
  ...stairs('deepslate_brick_stairs', 'deepslate_bricks'),
  {
    name: 'soul_lantern',
    model: 'boxes',
    textures: { all: 'soul_lantern' },
    boxes: [
      [5, 0, 5, 11, 7, 11],
      [6, 7, 6, 10, 9, 10],
    ],
    light: 15,
    secondLight: true,
  },
  {
    name: 'soul_strip',
    model: 'boxes',
    textures: { all: 'soul_lantern' },
    boxes: [[0, 0, 6, 16, 1, 10]],
    light: 8,
    secondLight: true,
  },
  { name: 'chain', model: 'boxes', textures: { all: 'chain' }, boxes: [[7, 0, 7, 9, 16, 9]] },
  {
    name: 'candles',
    model: 'boxes',
    textures: { all: 'candle' },
    boxes: [
      [3, 0, 3, 5, 5, 5],
      [9, 0, 5, 11, 7, 7],
      [6, 0, 10, 8, 4, 12],
    ],
    light: 12,
  },
]);

/** The game's stairs as boxes: a bottom slab and the upper half on the side named (n −z, s +z, w −x, e +x). */
function stairs(name: string, tile: string): BlockDefinition[] {
  const backs = {
    n: [0, 8, 0, 16, 16, 8],
    s: [0, 8, 8, 16, 16, 16],
    w: [0, 8, 0, 8, 16, 16],
    e: [8, 8, 0, 16, 16, 16],
  } as const;
  return Object.entries(backs).map(([side, back]) => ({
    name: `${name}_${side}`,
    model: 'boxes',
    textures: { all: tile },
    boxes: [[0, 0, 0, 16, 8, 16], back],
  }));
}
export const id = (name: string) => BLOCKS.id(name);

/** Seeded value noise, 0..1. */
export function noise(seed: number): (x: number, y: number, z: number) => number {
  const hash = (x: number, y: number, z: number) => {
    const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 19.3) * 43758.5453;
    return h - Math.floor(h);
  };
  const k = (t: number) => t * t * (3 - 2 * t),
    lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return (x, y, z) => {
    const xi = Math.floor(x),
      yi = Math.floor(y),
      zi = Math.floor(z),
      fx = k(x - xi),
      fy = k(y - yi),
      fz = k(z - zi);
    const plane = (dz: number) =>
      lerp(
        lerp(hash(xi, yi, zi + dz), hash(xi + 1, yi, zi + dz), fx),
        lerp(hash(xi, yi + 1, zi + dz), hash(xi + 1, yi + 1, zi + dz), fx),
        fy,
      );
    return lerp(plane(0), plane(1), fz);
  };
}

/** A tree the game's way: a log trunk and a blob of leaves, the corners of each layer thinned. */
export function tree(
  w: BlockWorld,
  x: number,
  y: number,
  z: number,
  height: number,
  kind: 'oak' | 'birch',
  rand: () => number,
): void {
  const log = id(`${kind}_log`),
    leaves = id(`${kind}_leaves`),
    top = y + height;
  for (let dy = -2; dy <= 1; dy++) {
    const r = dy >= 0 ? 1 : 2;
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r && (dy === 1 || rand() < 0.5)) continue;
        if (!w.get(x + dx, top + dy, z + dz)) w.set(x + dx, top + dy, z + dz, leaves);
      }
  }
  for (let k = 0; k < height; k++) w.set(x, y + k, z, log);
}

/** Light, mesh and group a finished world. */
export function render(world: BlockWorld, options: Omit<MeshOptions, 'uv'>): Group {
  computeLight(world, BLOCKS);
  const { texture, uv } = blockAtlas(),
    root = new Group();
  root.add(...worldMeshes(meshWorld(world, BLOCKS, { uv, ...options }), texture));
  return root;
}

/** Where a chest standing on top of cell (x, y, z) of a world goes, in scene coordinates. */
export const onTop = (w: BlockWorld, x: number, y: number, z: number): [number, number, number] => [
  x + w.origin[0] + 0.5,
  y + w.origin[1] + 1,
  z + w.origin[2] + 0.5,
];
