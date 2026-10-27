import { Group } from 'three';
import {
  BlockRegistry,
  BlockWorld,
  blockAtlas,
  computeLight,
  meshWorld,
  worldMeshes,
  type MeshOptions,
} from '../../../../../packages/blockworld/src/index.ts';

/**
 * What the three deep-mine composition studies are built from: vanilla-style blocks of the shared
 * atlas, a seeded noise for rough rock, and one call that lights, meshes and groups a world. Each
 * study is a BlockWorld lit by the game's rules (sky light, block light, smooth light, AO), no scene
 * lights: whatever is bright in the picture is bright because of a block or an opening to the sky.
 */
export const BLOCKS = new BlockRegistry([
  { name: 'stone', textures: { all: 'stone' } },
  { name: 'deepslate', textures: { all: 'deepslate' } },
  { name: 'cobblestone', textures: { all: 'cobblestone' } },
  { name: 'stone_bricks', textures: { all: 'stone_bricks' } },
  { name: 'gravel', textures: { all: 'gravel' } },
  { name: 'dirt', textures: { all: 'dirt' } },
  { name: 'bedrock', textures: { all: 'bedrock' } },
  { name: 'oak_log', textures: { side: 'oak_log', top: 'oak_log_top' } },
  { name: 'oak_planks', textures: { all: 'oak_planks' } },
  { name: 'calcite', textures: { all: 'calcite' } },
  { name: 'amethyst', textures: { all: 'amethyst' } },
  { name: 'obsidian', textures: { all: 'obsidian' } },
  { name: 'diamond_ore', textures: { all: 'diamond_ore' } },
  { name: 'gold_ore', textures: { all: 'gold_ore' } },
  { name: 'redstone_ore', textures: { all: 'redstone_ore' } },
  { name: 'lava', textures: { all: 'lava' }, light: 15 },
  { name: 'glowstone', textures: { all: 'glowstone' }, light: 15 },
  { name: 'torch', model: 'torch', textures: { all: 'torch' }, light: 14 },
  // The game gives a cluster 5; 10 here, or a geode lit only by them is a black room.
  { name: 'amethyst_cluster', model: 'cross', textures: { all: 'amethyst_cluster' }, light: 7 },
  { name: 'water', model: 'liquid', textures: { all: 'water' } },
]);
export const id = (name: string) => BLOCKS.id(name);

/** Seeded value noise in 3D, 0..1, for rock that is rough without being random per block. */
export function noise3(seed: number): (x: number, y: number, z: number) => number {
  const hash = (x: number, y: number, z: number) => {
    const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 19.3) * 43758.5453;
    return h - Math.floor(h);
  };
  const k = (t: number) => t * t * (3 - 2 * t);
  return (x, y, z) => {
    const xi = Math.floor(x),
      yi = Math.floor(y),
      zi = Math.floor(z),
      fx = k(x - xi),
      fy = k(y - yi),
      fz = k(z - zi);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const plane = (dz: number) =>
      lerp(
        lerp(hash(xi, yi, zi + dz), hash(xi + 1, yi, zi + dz), fx),
        lerp(hash(xi, yi + 1, zi + dz), hash(xi + 1, yi + 1, zi + dz), fx),
        fy,
      );
    return lerp(plane(0), plane(1), fz);
  };
}

/** Light the world, mesh it with the atlas and hand back the group a stage shows. */
export function render(world: BlockWorld, options: Omit<MeshOptions, 'uv'>): Group {
  computeLight(world, BLOCKS);
  const { texture, uv } = blockAtlas(),
    root = new Group();
  root.add(...worldMeshes(meshWorld(world, BLOCKS, { uv, ...options }), texture));
  return root;
}
