import type { BlockRegistry } from './blocks.ts';
import type { BlockWorld } from './world.ts';
import { brightness } from './mesher.ts';

/**
 * Light levels the way Minecraft spreads them, 0..15 per cell:
 * - sky light comes straight down at 15 until something opaque stops it (transparent blocks such as
 *   leaves take 1), then spreads sideways and under overhangs, losing 1 per block;
 * - block light floods out from glowing blocks (a torch gives 14), losing 1 per block — in two
 *   colours kept apart, the first and the second (`secondLight` blocks), so they mix where they meet.
 * Opaque cubes stop both. Run once after the world is built, before meshing.
 */
export function computeLight(world: BlockWorld, registry: BlockRegistry): void {
  const { sx, sy, sz } = world;
  world.sky.fill(0);
  world.glow.fill(0);
  world.glow2.fill(0);
  const opaque = (x: number, y: number, z: number) =>
    registry.get(world.get(x, y, z))?.opaque ?? false;
  const filter = (x: number, y: number, z: number) => {
    const block = registry.get(world.get(x, y, z));
    return block && block.transparent && block.model === 'cube' ? 1 : 0;
  };

  // Sky light straight down each column.
  const skyQueue: number[] = [];
  for (let z = 0; z < sz; z++)
    for (let x = 0; x < sx; x++) {
      let level = 15;
      for (let y = sy - 1; y >= 0 && level > 0; y--) {
        if (opaque(x, y, z)) break;
        level -= filter(x, y, z);
        world.sky[world.index(x, y, z)] = level;
        skyQueue.push(x, y, z);
      }
    }
  // Open sides: the sky beside the box (15) lights the cells along its sides as a neighbour would (14).
  if (world.openSides)
    for (let z = 0; z < sz; z++)
      for (let y = 0; y < sy; y++)
        for (let x = 0; x < sx; x++) {
          if ((x > 0 && x < sx - 1 && z > 0 && z < sz - 1) || opaque(x, y, z)) continue;
          const index = world.index(x, y, z),
            level = 14 - filter(x, y, z);
          if (world.sky[index]! < level) {
            world.sky[index] = level;
            skyQueue.push(x, y, z);
          }
        }
  spread(world, world.sky, skyQueue, opaque);

  // Block light from every glowing block.
  const glowQueue: number[] = [],
    glow2Queue: number[] = [];
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++) {
        const block = registry.get(world.get(x, y, z)),
          level = block?.light ?? 0;
        if (level <= 0) continue;
        if (block!.secondLight) {
          world.glow2[world.index(x, y, z)] = level;
          glow2Queue.push(x, y, z);
        } else {
          world.glow[world.index(x, y, z)] = level;
          glowQueue.push(x, y, z);
        }
      }
  spread(world, world.glow, glowQueue, opaque);
  spread(world, world.glow2, glow2Queue, opaque);
}

/** A local source for the blocks: its cell, the level it starts at, its colour (linear 0..1), strength and flicker amplitude. */
export interface RigSource {
  readonly cell: readonly [number, number, number];
  readonly level: number;
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly flicker: number;
}

/**
 * Light of local sources per cell, as block light spreads (losing a level per block, stopped by
 * opaque cubes, around corners) but each in its own colour, added up: `rgb` the light (3 per cell),
 * `flicker` the amplitude-weighted share of it that flickers (sum of brightness × flicker).
 * Kept for the box and a cell of air around it, where its outer faces look: `index` gives a cell's
 * place in both (-1 beyond).
 */
export interface RigLight {
  readonly rgb: Float32Array;
  readonly flicker: Float32Array;
  index(x: number, y: number, z: number): number;
}

/**
 * A source beyond the box comes in as through open air: each cell of the air around the box takes
 * its level less the blocks between them, as a flood through air would give it.
 */
export function computeRigLight(
  world: BlockWorld,
  registry: BlockRegistry,
  sources: readonly RigSource[],
): RigLight {
  // The box grown by a cell each side; grid (gx, gy, gz) is world (gx - 1, gy - 1, gz - 1).
  const sx = world.sx + 2,
    sy = world.sy + 2,
    sz = world.sz + 2;
  const grid = {
    index: (x: number, y: number, z: number) => x + sx * (y + sy * z),
    inside: (x: number, y: number, z: number) =>
      x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz,
  };
  const size = sx * sy * sz,
    rgb = new Float32Array(size * 3),
    flicker = new Float32Array(size),
    levels = new Uint8Array(size);
  const opaque = (x: number, y: number, z: number) =>
    registry.get(world.get(x - 1, y - 1, z - 1))?.opaque ?? false;
  for (const source of sources) {
    if (source.level <= 0 || source.intensity <= 0) continue;
    const x = source.cell[0] + 1,
      y = source.cell[1] + 1,
      z = source.cell[2] + 1,
      queue: number[] = [];
    if (grid.inside(x, y, z)) {
      levels[grid.index(x, y, z)] = source.level;
      queue.push(x, y, z);
    } else
      for (let cz = 0; cz < sz; cz++)
        for (let cy = 0; cy < sy; cy++) {
          const skin = cz === 0 || cz === sz - 1 || cy === 0 || cy === sy - 1;
          for (let cx = 0; cx < sx; cx += skin || cx === sx - 1 ? 1 : sx - 1) {
            const level = source.level - Math.abs(x - cx) - Math.abs(y - cy) - Math.abs(z - cz);
            if (level > 0) {
              levels[grid.index(cx, cy, cz)] = level;
              queue.push(cx, cy, cz);
            }
          }
        }
    spread(grid, levels, queue, opaque);
    const [r, g, b] = source.color,
      share = ((r + g + b) / 3) * source.flicker;
    // Every cell it reached (some more than once in the queue): add its light, then clear the level for the next source.
    for (let i = 0; i < queue.length; i += 3) {
      const index = grid.index(queue[i]!, queue[i + 1]!, queue[i + 2]!),
        level = levels[index]!;
      if (!level) continue;
      // Its reach scales the fall-off, not its strength: a short source is as bright at its heart as a long one (as its point light is on objects).
      const k = brightness((level * 15) / source.level) * source.intensity;
      rgb[index * 3] = rgb[index * 3]! + r * k;
      rgb[index * 3 + 1] = rgb[index * 3 + 1]! + g * k;
      rgb[index * 3 + 2] = rgb[index * 3 + 2]! + b * k;
      flicker[index] = flicker[index]! + share * k;
      levels[index] = 0;
    }
  }
  return {
    rgb,
    flicker,
    index: (x, y, z) => (grid.inside(x + 1, y + 1, z + 1) ? grid.index(x + 1, y + 1, z + 1) : -1),
  };
}

const STEPS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

/** Breadth-first flood: each cell passes its level minus one to non-opaque neighbours that have less. */
function spread(
  world: Pick<BlockWorld, 'index' | 'inside'>,
  levels: Uint8Array,
  queue: number[],
  opaque: (x: number, y: number, z: number) => boolean,
): void {
  for (let head = 0; head < queue.length; head += 3) {
    const x = queue[head]!,
      y = queue[head + 1]!,
      z = queue[head + 2]!;
    const next = levels[world.index(x, y, z)]! - 1;
    if (next <= 0) continue;
    for (const [dx, dy, dz] of STEPS) {
      const nx = x + dx,
        ny = y + dy,
        nz = z + dz;
      if (!world.inside(nx, ny, nz) || opaque(nx, ny, nz)) continue;
      const index = world.index(nx, ny, nz);
      if (levels[index]! >= next) continue;
      levels[index] = next;
      queue.push(nx, ny, nz);
    }
  }
}
