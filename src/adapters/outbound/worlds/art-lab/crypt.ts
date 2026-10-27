import {
  BlockWorld,
  type Stage,
  type StageBuilder,
} from '../../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../../application/ports/chest-handles.ts';
import { id, onTop, render } from './kit.ts';

/**
 * "Крипта": a symmetrical stone-brick nave, pillars in pairs, torches on every pillar, the chest on
 * an altar at the end of the nave. Architecture and symmetry carry it; nothing is random but the moss.
 *
 * The art-direction iterations are switches, so every before stays reproducible:
 *  key   — glowstone in the vault above the altar, the niche cut to a rim. REJECTED: block light never
 *          reaches the chest (it is lit by the stage's guest light), and the niche's halo was the
 *          only thing it read against;
 *  cold  — a slot in the roof behind the altar open to a moonlit sky: the renderer's one second
 *          colour (sky light) against the torches' warm. Kept;
 *  ribs  — ribs over every pillar pair and a lower camera: 1 cobble, the near brackets left in
 *          (noisy, cut off at the frame's edges); 2 stone bricks, no brackets nearer than the
 *          second pillar pair, a warmer key on the chest. 2 kept.
 */
const SX = 23,
  SY = 22,
  SZ = 44,
  AXIS = 11,
  FLOOR = 1,
  ALTAR_Z = 9;

export interface CryptSteps {
  readonly key?: boolean;
  readonly cold?: boolean;
  readonly ribs?: 0 | 1 | 2;
}

export function crypt(steps: CryptSteps): StageBuilder<ChestHandles> {
  const keyLight = steps.key === true,
    coldDepth = steps.cold === true,
    ribs = steps.ribs ?? 0,
    rhythm = ribs > 0;
  return {
    id: `art-crypt-v1-${keyLight ? 'k' : ''}${coldDepth ? 'c' : ''}r${ribs}`,
    build(seed): Stage<ChestHandles> {
      const w = new BlockWorld(SX, SY, SZ, [-AXIS, -FLOOR, -ALTAR_Z]);
      let state = seed * 4801;
      const rand = () => {
        state = (state * 16807) % 2147483647;
        return state / 2147483647;
      };
      const brick = () => id(rand() < 0.22 ? 'mossy_stone_bricks' : 'stone_bricks');
      for (let z = 0; z < SZ; z++)
        for (let y = 0; y < SY; y++) for (let x = 0; x < SX; x++) w.set(x, y, z, brick());
      // The nave: nine wide; the vault steps in by one each row above the springing line.
      for (let z = 4; z < SZ - 1; z++)
        for (let y = FLOOR; y < FLOOR + 9; y++) {
          const half = y < FLOOR + 6 ? 4 : 4 - (y - FLOOR - 5);
          for (let x = AXIS - half; x <= AXIS + half; x++) w.set(x, y, z, 0);
        }
      // Side aisles behind the pillars, lower and darker.
      for (let z = 8; z < SZ - 3; z++)
        for (let y = FLOOR; y < FLOOR + 5; y++)
          for (const x of [AXIS - 6, AXIS - 5, AXIS + 5, AXIS + 6]) w.set(x, y, z, 0);
      for (let z = 10; z < SZ - 3; z += 5)
        for (const side of [-1, 1]) {
          const x = AXIS + side * 4;
          for (let y = FLOOR; y < FLOOR + 6; y++) w.set(x, y, z, id('stone_bricks'));
          // Brackets and torches only where the frame shows them whole.
          if ((ribs === 1 && z > 25) || (ribs === 2 && z > 15)) continue;
          w.set(x - side, FLOOR + 3, z, id('torch'));
          w.set(x - side, FLOOR + 2, z, id('cobblestone'));
        }
      if (rhythm)
        for (let z = 10; z < SZ - 3; z += 5)
          for (let x = AXIS - 3; x <= AXIS + 3; x++)
            w.set(
              x,
              FLOOR + 6 + (Math.abs(x - AXIS) === 3 ? 0 : 1),
              z,
              id(ribs === 1 ? 'cobblestone' : 'stone_bricks'),
            );
      // Floor runner, altar, and the niche behind it.
      for (let z = 5; z < SZ - 1; z++) w.set(AXIS, FLOOR - 1, z, id('cobblestone'));
      for (let x = AXIS - 1; x <= AXIS + 1; x++) {
        w.set(x, FLOOR, ALTAR_Z, id('stone_bricks'));
        w.set(x, FLOOR, ALTAR_Z - 1, id('stone_bricks'));
      }
      w.set(AXIS, FLOOR + 1, ALTAR_Z, id('stone_bricks'));
      if (keyLight) {
        for (let x = AXIS - 1; x <= AXIS + 1; x++) w.set(x, FLOOR + 5, 3, id('glowstone'));
        for (let z = ALTAR_Z + 1; z <= ALTAR_Z + 2; z++) w.set(AXIS, FLOOR + 9, z, id('glowstone'));
      } else
        for (let y = FLOOR + 2; y < FLOOR + 6; y++)
          for (let x = AXIS - 1; x <= AXIS + 1; x++) w.set(x, y, 3, id('glowstone'));
      if (coldDepth)
        for (let z = 4; z <= 6; z++)
          for (let y = FLOOR + 6; y < SY; y++)
            for (let x = AXIS - 2; x <= AXIS + 2; x++) w.set(x, y, z, 0);
      const root = render(w, {
        glow: [1, 0.7, 0.42],
        sky: [0.42, 0.55, 0.95],
        minimum: 0.03,
        occlusion: 0.85,
      });
      const anchor = onTop(w, AXIS, FLOOR + 1, ALTAR_Z);
      return {
        root,
        living: [],
        calm: 0,
        flicker: 0.1,
        sky: { top: '#0a1230', horizon: '#1d2c55', bottom: '#000000' },
        fog: { color: '#0c0907', near: 20, far: 60 },
        camera: {
          position: [anchor[0], anchor[1] + (rhythm ? 1.7 : 2.2), anchor[2] + 14],
          target: [anchor[0], anchor[1] + 1.4, anchor[2]],
          fov: 56,
          drift: 0,
          focus: [0.5, 0.5],
        },
        anchor,
        ground: { floor: anchor[1] },
        light: {
          sky: coldDepth ? '#7a8cc8' : '#3a3028',
          ground: '#2a2018',
          key: ribs === 2 ? '#ffd2a0' : '#ffc890',
        },
      };
    },
  };
}

export const ART_CRYPT = crypt({});
