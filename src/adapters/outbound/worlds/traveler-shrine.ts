import {
  BlockWorld,
  type Stage,
  type StageBuilder,
} from '../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../application/ports/chest-handles.ts';
import { happenings } from './overworld-life.ts';
import { BLOCKS, id, noise, onTop, render, tree } from './art-lab/kit.ts';

/**
 * "Святилище Путника": a birch grove at golden hour and, in a clearing, a three-step stone
 * pedestal with torches at its corners and four whole pillars; a gravel path leads to it. The sun
 * hangs low behind it, so the leaves glow and the pillars throw long shadows towards the viewer.
 * The chest hangs over the pedestal and lands on its top.
 */
const SX = 60,
  SY = 34,
  SZ = 70,
  GROUND = 10,
  CX = 30,
  CZ = 40;
const SUN = [-0.18, 0.3, -0.94] as const;

export const TRAVELER_SHRINE: StageBuilder<ChestHandles> = {
  id: 'traveler-shrine-v1',
  build(seed): Stage<ChestHandles> {
    const w = new BlockWorld(SX, SY, SZ, [-CX, -GROUND, -CZ]),
      n = noise(seed);
    let state = seed * 9973 + 1;
    const rand = () => {
      state = (state * 16807) % 2147483647;
      return state / 2147483647;
    };
    const height = (x: number, z: number) =>
      GROUND +
      Math.round(
        (n(x * 0.08, 0, z * 0.08) - 0.5) *
          4 *
          Math.min(1, Math.max(0, Math.hypot(x - CX, z - CZ) - 16) / 12),
      );
    for (let z = 0; z < SZ; z++)
      for (let x = 0; x < SX; x++) {
        const h = height(x, z);
        w.fill(x, 0, z, x, h - 3, z, id('stone'));
        w.fill(x, h - 2, z, x, h - 1, z, id('dirt'));
        w.set(x, h, z, id('grass'));
      }
    // A level clearing under the pedestal, a gravel path from the viewer to its steps.
    for (let z = CZ - 6; z <= CZ + 6; z++)
      for (let x = CX - 6; x <= CX + 6; x++) {
        if (Math.hypot(x - CX, z - CZ) > 6) continue;
        w.fill(x, 1, z, x, GROUND, z, id('dirt'));
        w.set(x, GROUND, z, id('grass'));
      }
    for (let z = CZ + 4; z < SZ; z++)
      for (const dx of [-1, 0, 1])
        w.set(CX + dx + Math.round(Math.sin(z * 0.25)), GROUND, z, id('gravel'));
    // The pedestal: 7×7 base, 5×5 middle, 3×3 top (the chest's seat); mossy bricks sprinkled in.
    const brick = () => id(rand() < 0.25 ? 'mossy_stone_bricks' : 'stone_bricks');
    for (const [r, y] of [
      [3, 1],
      [2, 2],
      [1, 3],
    ] as const) {
      for (let z = CZ - r; z <= CZ + r; z++)
        for (let x = CX - r; x <= CX + r; x++) w.set(x, GROUND + y, z, brick());
    }
    // Torches at the base's corners, whole pillars with a torch on top at the four outer corners.
    for (const [dx, dz] of [
      [-3, -3],
      [3, -3],
      [-3, 3],
      [3, 3],
    ] as const)
      w.set(CX + dx, GROUND + 2, CZ + dz, id('torch'));
    for (const [dx, dz] of [
      [-5, -5],
      [5, -5],
      [-5, 5],
      [5, 5],
    ] as const) {
      for (let y = 1; y <= 4; y++) w.set(CX + dx, GROUND + y, CZ + dz, id('stone_bricks'));
      w.set(CX + dx, GROUND + 5, CZ + dz, id('torch'));
    }
    // The grove: birches behind and to the sides, an oak framing the left foreground.
    for (let i = 0; i < 30; i++) {
      const x = 4 + Math.floor(rand() * (SX - 8)),
        z = 4 + Math.floor(rand() * (CZ - 2));
      if (Math.hypot(x - CX, z - CZ) < 17) continue;
      tree(w, x, height(x, z) + 1, z, 5 + Math.floor(rand() * 3), 'birch', rand);
    }
    tree(w, CX - 10, height(CX - 10, CZ + 12) + 1, CZ + 12, 6, 'oak', rand);
    // Flowers and grass, thinning out towards the clearing so the pedestal reads.
    for (let z = 2; z < SZ - 2; z++)
      for (let x = 2; x < SX - 2; x++) {
        const y = height(x, z) + 1,
          far = Math.hypot(x - CX, z - CZ);
        if (w.get(x, y, z) || far < 7) continue;
        const r = rand();
        if (r < 0.15) w.set(x, y, z, id('tall_grass'));
        else if (r < 0.2) w.set(x, y, z, id(rand() < 0.6 ? 'poppy' : 'dandelion'));
      }
    const root = render(w, {
      sky: [1, 0.86, 0.72],
      minimum: 0.06,
      occlusion: 0.7,
      sun: { direction: SUN, color: [1, 0.78, 0.5], strength: 0.45, reach: 50 },
    });
    const anchor = onTop(w, CX, GROUND + 3, CZ);
    return {
      // Things happen on the flat meadow: a creeper comes for the chest (beside the pedestal), a rabbit hops by, a flock flies over.
      root,
      calm: 0.15,
      living: [
        happenings(
          root,
          { ground: 1, chest: anchor, road: () => 0, tint: [1, 0.86, 0.72], stand: [4.4, -1.5] },
          { only: ['creeper', 'rabbit', 'flock', 'falling-star'] },
        ),
      ],
      sky: { top: '#6f8cc0', horizon: '#f4c78e', bottom: '#d9a473' },
      fog: { color: '#eab98a', near: 30, far: 110 },
      sun: { direction: SUN, color: '#ffc27a', scatter: 1 },
      camera: {
        position: [anchor[0] + 2, anchor[1] + 2.4, anchor[2] + 9.5],
        target: [anchor[0], anchor[1] + 1, anchor[2] - 1],
        fov: 52,
        drift: 0.08,
        focus: [0.5, 0.46],
      },
      anchor,
      ground: {
        blocks: { world: w, registry: BLOCKS, around: [anchor[0], anchor[2]], radius: 10 },
      },
      light: { sky: '#cfd8f0', ground: '#7a5a3a', key: '#ffc88a' },
    };
  },
};
