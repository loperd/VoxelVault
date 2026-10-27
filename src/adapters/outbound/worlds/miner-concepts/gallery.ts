import {
  BlockWorld,
  computeRigLight,
  type Stage,
  type StageBuilder,
} from '../../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../../application/ports/chest-handles.ts';
import { BLOCKS, id, noise3, render } from './kit.ts';

/**
 * Study B, "Штольня": a timbered drift seen straight down its length. Oak frames every five blocks
 * give the rhythm, torches at every other frame leave pools of light and dark between them, and at
 * the far end the drift breaks into a lava-lit hall — the vanishing point glows. The chest stands
 * on the track in the nearest pool of light. One-point perspective.
 */
const SX = 25,
  SY = 18,
  SZ = 100,
  O = [-12, -2, -88] as const;
const AXIS = 12,
  FLOOR = 2,
  CHEST_Z = 86;

export const MINER_GALLERY: StageBuilder<ChestHandles> = {
  id: 'miner-concept-gallery-v1',
  build(seed): Stage<ChestHandles> {
    const w = new BlockWorld(SX, SY, SZ, O),
      n = noise3(seed);
    w.fill(0, 0, 0, SX - 1, SY - 1, SZ - 1, id('stone'));
    for (let z = 0; z < SZ; z++)
      for (let y = 0; y < SY; y++)
        for (let x = 0; x < SX; x++) {
          if (y < 5 + n(x * 0.2, y * 0.2, z * 0.2) * 3 && w.get(x, y, z))
            w.set(x, y, z, id('deepslate'));
        }
    // The drift: seven wide, five high, its walls a block rough either way.
    for (let z = 14; z < SZ - 2; z++)
      for (let y = FLOOR; y < SY; y++)
        for (let x = 0; x < SX; x++) {
          const half = 3 + (n(x * 0.35, y * 0.35, z * 0.35) - 0.5) * 2.2,
            roof = FLOOR + 5 + (n(x * 0.3, 7, z * 0.3) - 0.5) * 1.6;
          if (Math.abs(x - AXIS) <= half && y < roof) w.set(x, y, z, 0);
        }
    // The hall at the far end: a wide dome with a lava floor.
    for (let z = 1; z < 22; z++)
      for (let y = FLOOR - 2; y < SY - 1; y++)
        for (let x = 0; x < SX; x++) {
          if (
            ((x - AXIS) / 11) ** 2 +
              ((y - 6) / 9) ** 2 +
              ((z - 9) / 10) ** 2 +
              (n(x * 0.25, y * 0.25, z * 0.25) - 0.5) * 0.5 <
            1
          )
            w.set(x, y, z, y <= FLOOR - 1 ? id('lava') : 0);
        }
    // The track bed, and the frames: log posts, a plank cap; a torch at the foot of every other one.
    for (let z = 18; z < SZ - 2; z++)
      for (let x = AXIS - 1; x <= AXIS + 1; x++) w.set(x, FLOOR - 1, z, id('gravel'));
    for (let z = 20, k = 0; z < SZ - 3; z += 5, k++) {
      for (const x of [AXIS - 3, AXIS + 3])
        for (let y = FLOOR; y < FLOOR + 4; y++) w.set(x, y, z, id('oak_log'));
      for (let x = AXIS - 3; x <= AXIS + 3; x++) w.set(x, FLOOR + 4, z, id('oak_planks'));
      if (k % 2 === 0 && (k < 6 || k > 9))
        w.set(k % 4 === 0 ? AXIS - 2 : AXIS + 2, FLOOR, z + 1, id('torch'));
    }
    // A side drift to the left halfway down, lit from inside: a second, smaller depth.
    for (let z = 52; z < 56; z++)
      for (let y = FLOOR; y < FLOOR + 4; y++) for (let x = 1; x < AXIS - 2; x++) w.set(x, y, z, 0);
    w.set(3, FLOOR, 53, id('torch'));
    // Ore where the walls show.
    for (let z = 15; z < SZ - 2; z++)
      for (let y = FLOOR; y < FLOOR + 6; y++)
        for (let x = 1; x < SX - 1; x++) {
          if (w.get(x, y, z) !== id('stone') && w.get(x, y, z) !== id('deepslate')) continue;
          const open = !w.get(x + 1, y, z) || !w.get(x - 1, y, z);
          const v = n(x * 0.9, y * 0.9, z * 0.9);
          if (open && v > 0.8)
            w.set(x, y, z, id(v > 0.9 ? 'diamond_ore' : z % 3 ? 'redstone_ore' : 'gold_ore'));
        }
    const root = render(w, {
      rig: computeRigLight(w, BLOCKS, [
        { cell: [AXIS, FLOOR, 8], level: 30, color: [1, 0.45, 0.16], intensity: 1, flicker: 0.08 },
        {
          cell: [AXIS, FLOOR + 1, 17],
          level: 16,
          color: [1, 0.5, 0.2],
          intensity: 0.7,
          flicker: 0.08,
        },
      ]),
      glow: [1, 0.72, 0.42],
      minimum: 0.045,
      shadow: [0.5, 0.68, 1],
      occlusion: 0.8,
    });
    const anchor: [number, number, number] = [
      AXIS + O[0] + 0.5,
      FLOOR + O[1],
      CHEST_Z + O[2] + 0.5,
    ];
    return {
      root,
      living: [],
      calm: 0,
      flicker: 0.1,
      sky: { top: '#000000', horizon: '#000000', bottom: '#000000' },
      fog: { color: '#0e0a08', near: 45, far: 190 },
      camera: {
        position: [anchor[0], anchor[1] + 2.6, anchor[2] + 8.5],
        target: [anchor[0], anchor[1] + 1, anchor[2] - 4],
        fov: 60,
        drift: 0,
        focus: [0.5, 0.55],
      },
      anchor,
      ground: { floor: anchor[1] },
      light: { sky: '#3a2e26', ground: '#5a3a22', key: '#ffb070', from: [2, 0.8, 4.5] },
    };
  },
};
