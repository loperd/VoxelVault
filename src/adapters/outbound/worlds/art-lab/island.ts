import {
  BlockWorld,
  type Stage,
  type StageBuilder,
} from '../../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../../application/ports/chest-handles.ts';
import { id, noise, onTop, render, tree } from './kit.ts';

/**
 * "Небесный остров": a small floating island in open sky, the chest at its edge, a waterfall
 * pouring off the rim into nothing, two smaller islands far off for depth. One strong silhouette
 * against a bright sky; the camera stands a little below the rim, so the island's rough underside
 * is part of the picture.
 */
const S = 64,
  TOP = 34,
  CX = 30,
  CZ = 30;
const SUN = [0.55, 0.7, 0.45] as const;

function island(
  w: BlockWorld,
  n: (x: number, y: number, z: number) => number,
  cx: number,
  cz: number,
  top: number,
  radius: number,
  depth: number,
): void {
  for (let z = 0; z < S; z++)
    for (let x = 0; x < S; x++) {
      const r = Math.hypot(x - cx, z - cz) / radius + (n(x * 0.2, 0, z * 0.2) - 0.5) * 0.35;
      if (r >= 1) continue;
      const bottom =
        top - Math.round(depth * (1 - r) ** 0.7 * (0.7 + n(x * 0.3, 5, z * 0.3) * 0.6));
      for (let y = bottom; y <= top; y++)
        w.set(x, y, z, id(y === top ? 'grass' : y > top - 3 ? 'dirt' : 'stone'));
    }
}

export const ART_ISLAND: StageBuilder<ChestHandles> = {
  id: 'art-island-v1',
  build(seed): Stage<ChestHandles> {
    const w = new BlockWorld(S, 48, S, [-CX, -TOP, -CZ]),
      n = noise(seed);
    let state = seed * 7919;
    const rand = () => {
      state = (state * 16807) % 2147483647;
      return state / 2147483647;
    };
    island(w, n, CX, CZ - 3, TOP, 10, 16);
    island(w, n, 8, 6, TOP + 8, 3.5, 6);
    island(w, n, 56, 10, TOP - 6, 4.5, 7);
    tree(w, CX - 3, TOP + 1, CZ - 7, 6, 'birch', rand);
    tree(w, CX + 4, TOP + 1, CZ - 9, 5, 'oak', rand);
    // A pool on top spilling over the rim: the fall hangs down to the bottom of the world.
    for (let z = CZ - 5; z <= CZ - 3; z++)
      for (let x = CX + 5; x <= CX + 7; x++) w.set(x, TOP, z, id('water'));
    for (let x = CX + 7; x <= CX + 13; x++) w.set(x, TOP, CZ - 4, id('water'));
    for (let y = 2; y < TOP; y++)
      if (!w.get(CX + 13, y, CZ - 4)) w.set(CX + 13, y, CZ - 4, id('water'));
    for (let i = 0; i < 40; i++) {
      const x = CX - 9 + Math.floor(rand() * 18),
        z = CZ - 12 + Math.floor(rand() * 16);
      if (
        w.get(x, TOP, z) === id('grass') &&
        !w.get(x, TOP + 1, z) &&
        Math.hypot(x - CX, z - (CZ + 2)) > 2
      )
        w.set(x, TOP + 1, z, id(rand() < 0.8 ? 'tall_grass' : 'poppy'));
    }
    const chest = [CX, TOP, CZ + 3] as const;
    w.set(chest[0], chest[1], chest[2], id('grass'));
    const root = render(w, {
      sky: [1, 1, 1],
      minimum: 0.08,
      occlusion: 0.65,
      sun: { direction: SUN, color: [1, 0.95, 0.85], strength: 0.35, reach: 48 },
    });
    const anchor = onTop(w, ...chest);
    return {
      root,
      living: [],
      calm: 0.2,
      sky: { top: '#3f78cf', horizon: '#cfe4fb', bottom: '#eef5ff' },
      fog: { color: '#d6e6f8', near: 40, far: 150 },
      sun: { direction: SUN, color: '#fff2d6', scatter: 0.5 },
      camera: {
        position: [anchor[0] - 5, anchor[1] - 0.5, anchor[2] + 10],
        target: [anchor[0] + 1, anchor[1] + 0.6, anchor[2] - 2],
        fov: 58,
        drift: 0,
        focus: [0.5, 0.46],
      },
      anchor,
      ground: { floor: anchor[1] },
      light: { sky: '#dce9ff', ground: '#6f7f5a', key: '#fff2d6' },
    };
  },
};
