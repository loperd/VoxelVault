import {
  BlockWorld,
  type Stage,
  type StageBuilder,
} from '../../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../../application/ports/chest-handles.ts';
import { id, noise, onTop, render, tree } from './kit.ts';

/**
 * "Святилище в роще": a ruined shrine in a birch grove at golden hour. The sun hangs low behind the
 * ruin, so the leaves glow through, the pillars throw long shadows towards the viewer and the haze
 * behind the chest is the brightest part of the picture. Uses what the renderer does best: sky
 * light, the baked sun and its shadows, backlit leaves, sun-coloured haze.
 */
const SX = 60,
  SY = 34,
  SZ = 70,
  GROUND = 10,
  CX = 30,
  CZ = 40;
const SUN = [-0.18, 0.3, -0.94] as const;

export const ART_SHRINE: StageBuilder<ChestHandles> = {
  id: 'art-shrine-v1',
  build(seed): Stage<ChestHandles> {
    const w = new BlockWorld(SX, SY, SZ, [-CX, -GROUND, -CZ]),
      n = noise(seed);
    let state = seed * 9973;
    const rand = () => {
      state = (state * 16807) % 2147483647;
      return state / 2147483647;
    };
    const height = (x: number, z: number) =>
      GROUND +
      Math.round(
        (n(x * 0.08, 0, z * 0.08) - 0.5) * 4 * Math.min(1, Math.hypot(x - CX, z - CZ) / 12),
      );
    for (let z = 0; z < SZ; z++)
      for (let x = 0; x < SX; x++) {
        const h = height(x, z);
        w.fill(x, 0, z, x, h - 3, z, id('stone'));
        w.fill(x, h - 2, z, x, h - 1, z, id('dirt'));
        w.set(x, h, z, id('grass'));
      }
    // The shrine: a two-step plinth, four broken pillars of different heights, one fallen.
    for (let z = CZ - 3; z <= CZ + 3; z++)
      for (let x = CX - 3; x <= CX + 3; x++)
        w.set(x, GROUND + 1, z, id(rand() < 0.35 ? 'mossy_stone_bricks' : 'stone_bricks'));
    for (let z = CZ - 1; z <= CZ + 1; z++)
      for (let x = CX - 1; x <= CX + 1; x++) w.set(x, GROUND + 2, z, id('stone_bricks'));
    for (const [dx, dz, h] of [
      [-3, -3, 7],
      [3, -3, 4],
      [-3, 3, 2],
      [3, 3, 5],
    ] as const)
      for (let y = 2; y < 2 + h; y++)
        w.set(
          CX + dx,
          GROUND + y,
          CZ + dz,
          id(y > 3 && rand() < 0.5 ? 'mossy_stone_bricks' : 'stone_bricks'),
        );
    for (let k = 0; k < 4; k++)
      w.set(CX + 5 + k, GROUND + 1, CZ + 2 + (k > 1 ? 1 : 0), id('mossy_stone_bricks'));
    // The grove: birches behind and to the sides, an oak framing the left foreground.
    for (let i = 0; i < 26; i++) {
      const x = 4 + Math.floor(rand() * (SX - 8)),
        z = 4 + Math.floor(rand() * (CZ - 2));
      if (Math.hypot(x - CX, z - CZ) < 9) continue;
      tree(w, x, height(x, z) + 1, z, 5 + Math.floor(rand() * 3), 'birch', rand);
    }
    tree(w, CX - 9, height(CX - 9, CZ + 12) + 1, CZ + 12, 6, 'oak', rand);
    // Grass and flowers, thicker away from the path the eye takes to the shrine.
    for (let z = 2; z < SZ - 2; z++)
      for (let x = 2; x < SX - 2; x++) {
        const y = height(x, z) + 1,
          away = Math.abs(x - CX) > 2 || z < CZ;
        if (w.get(x, y, z) || Math.hypot(x - CX, z - CZ) < 4.5) continue;
        const r = rand();
        if (away && r < 0.16) w.set(x, y, z, id('tall_grass'));
        else if (away && r < 0.19) w.set(x, y, z, id(rand() < 0.6 ? 'poppy' : 'dandelion'));
      }
    const root = render(w, {
      sky: [1, 0.86, 0.72],
      minimum: 0.06,
      occlusion: 0.7,
      sun: { direction: SUN, color: [1, 0.78, 0.5], strength: 0.45, reach: 50 },
    });
    const anchor = onTop(w, CX, GROUND + 2, CZ);
    return {
      root,
      living: [],
      calm: 0.15,
      sky: { top: '#6f8cc0', horizon: '#f4c78e', bottom: '#d9a473' },
      fog: { color: '#eab98a', near: 30, far: 110 },
      sun: { direction: SUN, color: '#ffc27a', scatter: 1 },
      camera: {
        position: [anchor[0] + 2.5, anchor[1] + 2.6, anchor[2] + 10],
        target: [anchor[0], anchor[1] + 1.2, anchor[2] - 2],
        fov: 55,
        drift: 0,
        focus: [0.5, 0.5],
      },
      anchor,
      ground: { floor: anchor[1] },
      light: { sky: '#cfd8f0', ground: '#7a5a3a', key: '#ffc88a' },
    };
  },
};
