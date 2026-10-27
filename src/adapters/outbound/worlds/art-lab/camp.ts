import {
  BlockWorld,
  type Stage,
  type StageBuilder,
} from '../../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../../application/ports/chest-handles.ts';
import { id, noise, onTop, render, tree } from './kit.ts';

/**
 * "Ночной привал": a snowfield at night, a campfire in a ring of cobble beside the chest, torches on
 * two posts. The only two colours the renderer can mix — sky light (moon blue) and block light (fire
 * orange) — are the whole idea: a warm island of light in a cold field, dark oaks at its edge.
 */
const S = 64,
  GROUND = 8,
  CX = 32,
  CZ = 36;
const MOON = [0.45, 0.55, -0.7] as const;

export const ART_CAMP: StageBuilder<ChestHandles> = {
  id: 'art-camp-v1',
  build(seed): Stage<ChestHandles> {
    const w = new BlockWorld(S, 30, S, [-CX, -GROUND, -CZ]),
      n = noise(seed);
    let state = seed * 3571;
    const rand = () => {
      state = (state * 16807) % 2147483647;
      return state / 2147483647;
    };
    const height = (x: number, z: number) =>
      GROUND +
      Math.round(
        (n(x * 0.06, 0, z * 0.06) - 0.5) * 6 * Math.min(1, Math.hypot(x - CX, z - CZ) / 14),
      );
    for (let z = 0; z < S; z++)
      for (let x = 0; x < S; x++) {
        const h = height(x, z);
        w.fill(x, 0, z, x, h - 2, z, id('stone'));
        w.set(x, h - 1, z, id('dirt'));
        w.set(x, h, z, id('snow'));
      }
    // The fire: lava in a cobble ring; two log benches; torch posts.
    for (let z = CZ - 3; z <= CZ - 1; z++)
      for (let x = CX + 2; x <= CX + 4; x++)
        w.set(x, GROUND, z, id(x === CX + 3 && z === CZ - 2 ? 'lava' : 'cobblestone'));
    for (const [x, z] of [
      [CX + 6, CZ - 2],
      [CX + 3, CZ - 5],
    ] as const)
      w.set(x, GROUND + 1, z, id('oak_log'));
    for (const [x, z] of [
      [CX - 3, CZ - 2],
      [CX + 1, CZ - 6],
    ] as const) {
      w.set(x, GROUND + 1, z, id('oak_planks'));
      w.set(x, GROUND + 2, z, id('torch'));
    }
    // A dark wood round the clearing, thinner towards the camera.
    for (let i = 0; i < 40; i++) {
      const x = 3 + Math.floor(rand() * (S - 6)),
        z = 3 + Math.floor(rand() * (S - 6));
      const d = Math.hypot(x - CX, z - CZ);
      if (d < 11 || (z > CZ + 4 && d < 22)) continue;
      tree(w, x, height(x, z) + 1, z, 5 + Math.floor(rand() * 3), 'oak', rand);
    }
    const root = render(w, {
      sky: [0.32, 0.42, 0.78],
      glow: [1, 0.62, 0.3],
      minimum: 0.03,
      occlusion: 0.7,
      sun: { direction: MOON, color: [0.7, 0.8, 1], strength: 0.3, reach: 40 },
    });
    const anchor = onTop(w, CX, GROUND, CZ);
    return {
      root,
      living: [],
      calm: 0.05,
      flicker: 0.14,
      sky: { top: '#070d22', horizon: '#22335e', bottom: '#0b1020' },
      fog: { color: '#18223f', near: 25, far: 90 },
      sun: { direction: MOON, color: '#9fb6ff', scatter: 0.35 },
      camera: {
        position: [anchor[0] - 2, anchor[1] + 2.8, anchor[2] + 10],
        target: [anchor[0] + 1.5, anchor[1] + 0.8, anchor[2] - 2],
        fov: 56,
        drift: 0,
        focus: [0.5, 0.5],
      },
      anchor,
      ground: { floor: anchor[1] },
      light: { sky: '#6b80c0', ground: '#4a2a18', key: '#ffa860' },
    };
  },
};
