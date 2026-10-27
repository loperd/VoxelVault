import {
  BlockWorld,
  computeRigLight,
  type Stage,
  type StageBuilder,
} from '../../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../../application/ports/chest-handles.ts';
import { BLOCKS, id, noise3, render } from './kit.ts';

/**
 * Study A, "Провал": a cathedral-high cavern under a sinkhole. Daylight falls down the shaft onto a
 * stone-brick dais in a moat of lava; the chest stands where the two lights meet, cool from above,
 * warm from below. A lavafall in the back wall answers the moat; a broken causeway leads the eye
 * from the camera to the dais. Vertical composition: shaft, dais, moat.
 */
const SX = 48,
  SY = 54,
  SZ = 56,
  O = [-24, -10, -30] as const;
const DAIS = [24, 30] as const,
  TOP = 10;

export const MINER_SINKHOLE: StageBuilder<ChestHandles> = {
  id: 'miner-concept-sinkhole-v1',
  build(seed): Stage<ChestHandles> {
    const w = new BlockWorld(SX, SY, SZ, O),
      n = noise3(seed),
      [dx, dz] = DAIS;
    const flat = (x: number, z: number) => Math.hypot(x - dx, z - dz);
    for (let z = 0; z < SZ; z++)
      for (let y = 0; y < SY; y++)
        for (let x = 0; x < SX; x++) {
          const d =
            ((x - 24) / 20) ** 2 +
            ((y - 19) / 14) ** 2 +
            ((z - 29) / 24) ** 2 +
            (n(x * 0.18, y * 0.18, z * 0.18) - 0.5) * 0.5;
          // The shaft: straight up from the dais, ragged, wider at the top where the rock broke away.
          const shaft =
            y > 20 &&
            flat(x, z) < 4.2 + (y - 20) * 0.06 + (n(x * 0.3, y * 0.12, z * 0.3) - 0.5) * 2.4;
          const open = (d < 1 && y >= 7) || shaft;
          w.set(
            x,
            y,
            z,
            open ? 0 : id(y < 16 + n(x * 0.1, 0, z * 0.1) * 6 ? 'deepslate' : 'stone'),
          );
        }
    // Floor: a moat of lava round the dais, gravel and stone beyond it.
    for (let z = 0; z < SZ; z++)
      for (let x = 0; x < SX; x++) {
        if (w.get(x, 7, z)) continue;
        const r = flat(x, z) + (n(x * 0.4, 3, z * 0.4) - 0.5) * 2;
        w.set(x, 6, z, id(r < 11 ? 'lava' : 'stone'));
        if (r >= 11) w.set(x, 7, z, id(n(x * 0.5, 9, z * 0.5) > 0.55 ? 'gravel' : 'stone'));
      }
    // The dais: a rough cobble island, two dressed stone-brick steps, the chest on the top one.
    for (let z = 0; z < SZ; z++)
      for (let x = 0; x < SX; x++) {
        const r = flat(x, z);
        if (r < 5.6 + (n(x * 0.5, 1, z * 0.5) - 0.5) * 1.6)
          for (let y = 6; y <= 8; y++) w.set(x, y, z, id('cobblestone'));
        if (r < 3.9) w.set(x, 9, z, id('stone_bricks'));
        if (r < 1.6) w.set(x, TOP, z, id('stone_bricks'));
      }
    // A broken causeway towards the camera: one block wide gaps where it fell into the lava.
    for (let z = dz + 6; z < 50; z++)
      for (let x = dx - 1; x <= dx + 1; x++)
        if ((z * 7 + x * 3) % 11 > 1) w.set(x, 7, z, id('stone_bricks'));
    // The lavafall: out of the back wall, down to the moat.
    for (let y = 8; y < 34; y++)
      for (let x = 14; x <= 15; x++) {
        let z = 1;
        while (z < SZ - 1 && w.get(x, y, z)) z++;
        if (z < SZ - 1) w.set(x, y, z - 1, id('lava'));
      }
    // Stalactites from the vault, a few seams of ore where the wall shows.
    for (let i = 0; i < 40; i++) {
      const x = 6 + (Math.floor(n(i, 1, 2) * 36 * 7) % 36),
        z = 6 + (Math.floor(n(2, i, 1) * 44 * 7) % 44);
      if (flat(x, z) < 6) continue;
      let y = SY - 2;
      while (y > 8 && !(w.get(x, y, z) && !w.get(x, y - 1, z))) y--;
      for (let k = 1; k <= 2 + (i % 5); k++) w.set(x, y - k, z, id('stone'));
    }
    for (let z = 1; z < SZ - 1; z++)
      for (let y = 8; y < 30; y++)
        for (let x = 1; x < SX - 1; x++) {
          if (w.get(x, y, z) !== id('stone') && w.get(x, y, z) !== id('deepslate')) continue;
          if (
            n(x * 0.7, y * 0.7, z * 0.7) > 0.83 &&
            (!w.get(x + 1, y, z) || !w.get(x - 1, y, z) || !w.get(x, y, z + 1))
          )
            w.set(x, y, z, id(y < 16 ? 'diamond_ore' : 'gold_ore'));
        }
    const moat = Array.from(
      { length: 10 },
      (_, i) =>
        [
          Math.round(dx + Math.cos((i * Math.PI) / 5) * 13),
          8,
          Math.round(dz + Math.sin((i * Math.PI) / 5) * 13),
        ] as const,
    )
      .filter(([x, y, z]) => !w.get(x, y, z))
      .map((cell) => ({
        cell,
        level: 24,
        color: [1, 0.25, 0.05] as const,
        intensity: 0.45,
        flicker: 0.06,
      }));
    const root = render(w, {
      rig: computeRigLight(w, BLOCKS, moat),
      sky: [0.62, 0.74, 1],
      glow: [1, 0.4, 0.14],
      minimum: 0.035,
      occlusion: 0.75,
      sun: { direction: [0.12, 1, -0.18], color: [1, 0.93, 0.8], strength: 0.45, reach: 60 },
    });
    const anchor: [number, number, number] = [dx + O[0] + 0.5, TOP + O[1] + 1, dz + O[2] + 0.5];
    return {
      root,
      living: [],
      calm: 0,
      flicker: 0.06,
      sky: { top: '#a9c8f2', horizon: '#dfe9f5', bottom: '#2a2c34' },
      fog: { color: '#1a1512', near: 34, far: 95 },
      sun: { direction: [0.12, 1, -0.18], color: '#fff1d8', scatter: 0.5 },
      // Far and low enough to show the dais whole in its moat, with the shaft's daylight above it.
      camera: {
        position: [anchor[0] - 3, anchor[1] + 5, anchor[2] + 18],
        target: [anchor[0], anchor[1] + 5, anchor[2]],
        fov: 66,
        drift: 0,
        focus: [0.5, 0.38],
      },
      anchor,
      ground: { floor: anchor[1] },
      light: {
        sky: '#b9cdf0',
        ground: '#c2501c',
        key: '#ffe6c0',
        from: [-0.3, 0.5, 1],
        fillStrength: 3.2,
      },
    };
  },
};
