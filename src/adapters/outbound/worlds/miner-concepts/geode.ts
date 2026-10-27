import {
  BlockWorld,
  computeRigLight,
  type Stage,
  type StageBuilder,
} from '../../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../../application/ports/chest-handles.ts';
import { BLOCKS, id, noise3, render } from './kit.ts';

/**
 * Study C, "Жеода": inside an amethyst geode, the way the game layers it — basalt-dark deepslate,
 * white calcite, violet amethyst — and lit only by its own clusters. A calcite pedestal in the middle
 * of the floor holds the chest; the clusters thicken round it, so the brightest violet frames it.
 * An enclosed, round composition: no horizon, the shell itself is the frame.
 */
const S = 42,
  C = 21,
  O = [-21, -9, -21] as const;
const FLOOR = 12,
  PEDESTAL = 14;

export const MINER_GEODE: StageBuilder<ChestHandles> = {
  id: 'miner-concept-geode-v1',
  build(seed): Stage<ChestHandles> {
    const w = new BlockWorld(S, S, S, O),
      n = noise3(seed);
    for (let z = 0; z < S; z++)
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          // Slightly flattened, so the floor is wide and the vault high.
          const r =
            Math.hypot(x - C, (y - C) * 1.12, z - C) + (n(x * 0.2, y * 0.2, z * 0.2) - 0.5) * 2.6;
          w.set(
            x,
            y,
            z,
            r < 13
              ? y <= FLOOR
                ? id('amethyst')
                : 0
              : r < 14.1
                ? id('amethyst')
                : r < 15.2
                  ? id('calcite')
                  : r < 16.6
                    ? id('deepslate')
                    : id('stone'),
          );
        }
    for (let y = FLOOR + 1; y <= PEDESTAL; y++)
      for (let z = C - 1; z <= C + 1; z++)
        for (let x = C - 1; x <= C + 1; x++) {
          if (y < PEDESTAL || x === C || z === C) w.set(x, y, z, id('calcite'));
        }
    w.set(C, PEDESTAL, C, id('calcite'));
    // Clusters wherever air touches amethyst (floor, walls, vault), thicker near the pedestal.
    const amethyst = id('amethyst');
    for (let z = 1; z < S - 1; z++)
      for (let y = FLOOR + 1; y < S - 1; y++)
        for (let x = 1; x < S - 1; x++) {
          if (
            w.get(x, y, z) ||
            ![
              [0, -1, 0],
              [0, 1, 0],
              [1, 0, 0],
              [-1, 0, 0],
              [0, 0, 1],
              [0, 0, -1],
            ].some(([a, b, c]) => w.get(x + a!, y + b!, z + c!) === amethyst)
          )
            continue;
          const near = Math.max(0, 1 - Math.hypot(x - C, z - C) / 9);
          if (n(x * 1.7, y * 1.7, z * 1.7) < 0.18 + near * 0.35)
            w.set(x, y, z, id('amethyst_cluster'));
        }
    const ring = Array.from({ length: 6 }, (_, i) => ({
      cell: [
        Math.round(C + Math.cos((i * Math.PI) / 3) * 3),
        FLOOR + 1,
        Math.round(C + Math.sin((i * Math.PI) / 3) * 3),
      ] as const,
      level: 12,
      color: [0.86, 0.55, 1] as const,
      intensity: 0.22,
      flicker: 0.03,
    }));
    const root = render(w, {
      rig: computeRigLight(w, BLOCKS, ring),
      glow: [0.78, 0.52, 1],
      minimum: 0.035,
      occlusion: 0.7,
    });
    const anchor: [number, number, number] = [C + O[0] + 0.5, PEDESTAL + O[1] + 1, C + O[2] + 0.5];
    return {
      root,
      living: [],
      calm: 0,
      flicker: 0.03,
      sky: { top: '#000000', horizon: '#000000', bottom: '#000000' },
      fog: { color: '#120a1c', near: 14, far: 48 },
      camera: {
        position: [anchor[0] + 3, anchor[1] + 3.2, anchor[2] + 9.5],
        target: [anchor[0], anchor[1] + 1, anchor[2]],
        fov: 64,
        drift: 0,
        focus: [0.5, 0.55],
      },
      anchor,
      ground: { floor: anchor[1] },
      light: { sky: '#7d5aa8', ground: '#3a2450', key: '#d9b4ff', from: [0.5, 0.6, 1] },
    };
  },
};
