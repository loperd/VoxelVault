import {
  BlockWorld,
  type Stage,
  type StageBuilder,
} from '../../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../../application/ports/chest-handles.ts';
import { id, noise, render } from './kit.ts';

/**
 * Geometry study of the ancient city's frame (artifacts/visual-design/brief.md): the masses of the
 * reference in blocks, in neutral light from an open sky, seen from far and high through a narrow
 * lens — near-isometric, as the reference. No chest, no fog, no lights, no decor: only form.
 * Variants are kept side by side, each one a fixed set of switches, so every capture can be redone.
 */
export interface FrameStudy {
  /** Crumbled outer edges, stepped opening, mixed bricks/tiles/cobbled faces. */
  readonly ruin?: boolean;
  /** The side "ears", the opening's reinforced lining, the niches in the base's front. */
  readonly detail?: boolean;
  /**
   * The slot: `high` 20 × 9 raised 7 (the brief's estimate), `low` 22 × 7 raised 5 — the critic's
   * reading of the reference (artifacts/visual-design/study/critic-b.md), the frame lower to keep its lintel.
   */
  readonly slot?: 'high' | 'low';
  /**
   * How deep the ruin bites: `deep` notches 1–2 deep, more at the corners, teeth two down from the
   * lintel; `chips` single blocks off the outer shell, sparse, the corners and the lintel whole — what
   * both critics asked for (critic-b.md, critic-c.md), and then called a clean blockout (critic-d.md);
   * `outline` 2–4-block runs along the outer edges cut 1–2 deep through the whole thickness or
   * raised by one, the top corners stepped back — the silhouette broken, the faces whole.
   */
  readonly erosion?: 'deep' | 'chips' | 'outline';
}

// The base: 35 along the frame (x), 25 deep (z), 9 high; the frame on its rear third.
const X = 41,
  Y = 36,
  Z = 27,
  B = { x0: 3, x1: 37, z0: 0, z1: 24, top: 8 };
// The frame: 31 long, 6 deep; 20 high with a 20 × 9 slot raised 7 above the terrace, or 17 with a 22 × 7 one raised 5.
const SLOTS = {
  high: { x0: 5, x1: 35, z0: 2, z1: 7, y0: 9, y1: 28, open: { x0: 11, x1: 30, y0: 16, y1: 24 } },
  low: { x0: 5, x1: 35, z0: 2, z1: 7, y0: 9, y1: 25, open: { x0: 10, x1: 31, y0: 14, y1: 20 } },
} as const;
const SKY = { top: '#9fb3c4', horizon: '#c9d3db', bottom: '#c9d3db' };

export function frameStudy(
  name: string,
  { ruin = false, detail = false, slot = 'high', erosion = 'deep' }: FrameStudy,
): StageBuilder<ChestHandles> {
  return {
    id: `frame-study-${name}`,
    build(seed): Stage<ChestHandles> {
      const F = SLOTS[slot],
        n = noise(seed),
        w = new BlockWorld(X, Y, Z, [-20, -B.top - 1, -12]);
      const bricks = (x: number, y: number, z: number) =>
        !ruin
          ? id('deepslate_bricks')
          : n(x * 0.3, y * 0.3, z * 0.3) > 0.68
            ? id('deepslate_tiles')
            : n(x * 0.25 + 9, y * 0.25, z * 0.25) > 0.72
              ? id('deepslate')
              : id('deepslate_bricks');

      // Base: two rough courses, bricks above.
      for (let y = 0; y <= B.top; y++)
        for (let z = B.z0; z <= B.z1; z++)
          for (let x = B.x0; x <= B.x1; x++)
            w.set(x, y, z, y < 2 ? id('deepslate') : bricks(x, y, z));
      // The terrace's front-left quarter two lower, a broad stair up to the frame's level.
      for (let z = 15; z <= B.z1; z++)
        for (let x = B.x0; x <= 17; x++) for (let y = 7; y <= B.top; y++) w.set(x, y, z, 0);
      for (let x = 8; x <= 12; x++) {
        w.set(x, 7, 14, id('deepslate_brick_stairs_n'));
        w.set(x, 8, 14, 0);
        w.set(x, 8, 13, id('deepslate_brick_stairs_n'));
      }
      // Two low daises on the terrace.
      for (const [cx, cz] of [
        [24, 16],
        [31, 12],
      ] as const)
        for (let z = cz - 1; z <= cz + 1; z++)
          for (let x = cx - 1; x <= cx + 1; x++) w.set(x, B.top + 1, z, bricks(x, 9, z));

      // Plinth: two steps around the frame's foot, wider at the front.
      for (const [y, grow, front] of [
        [9, 2, 3],
        [10, 1, 1],
      ] as const)
        for (let z = Math.max(B.z0, F.z0 - grow); z <= F.z1 + front; z++)
          for (let x = F.x0 - grow; x <= F.x1 + grow; x++) w.set(x, y, z, bricks(x, y, z));

      // Frame: a thick ring with a slot.
      const { open } = F;
      for (let y = F.y0; y <= F.y1; y++)
        for (let z = F.z0; z <= F.z1; z++)
          for (let x = F.x0; x <= F.x1; x++) {
            if (x >= open.x0 && x <= open.x1 && y >= open.y0 && y <= open.y1) continue;
            w.set(x, y, z, bricks(x, y, z));
          }

      if (ruin && erosion === 'deep') {
        // Broken outer edges: notches 1–2 deep along the top, down the outer sides, at the corners.
        for (let y = F.y0 + 4; y <= F.y1; y++)
          for (let z = F.z0; z <= F.z1; z++)
            for (let x = F.x0; x <= F.x1; x++) {
              const edge = Math.min(F.y1 - y, x - F.x0, F.x1 - x, z - F.z0, F.z1 - z);
              if (edge > 1) continue;
              const corner = (F.y1 - y < 3 ? 1 : 0) + (x - F.x0 < 3 || F.x1 - x < 3 ? 1 : 0);
              if (n(x * 0.5, y * 0.5, z * 0.5) < 0.22 + corner * 0.14 - edge * 0.12)
                w.set(x, y, z, 0);
            }
        // The slot's edges stepped: teeth hanging from the lintel, the sill's lip broken.
        for (let x = open.x0; x <= open.x1; x++)
          for (let z = F.z0; z <= F.z1; z++) {
            const t = n(x * 0.4, 3, z * 0.4);
            if (t > 0.6) w.set(x, open.y1, z, bricks(x, open.y1, z));
            if (t > 0.78) w.set(x, open.y1 - 1, z, bricks(x, open.y1 - 1, z));
            if (n(x * 0.4, 7, z * 0.4) > 0.7) w.set(x, open.y0 - 1, z, 0);
          }
      }
      if (ruin && erosion === 'chips') {
        // Single blocks off the outer shell, one in six or so; the outer corners kept whole.
        for (let y = F.y0 + 4; y <= F.y1; y++)
          for (let z = F.z0; z <= F.z1; z++)
            for (let x = F.x0; x <= F.x1; x++) {
              const edge = Math.min(F.y1 - y, x - F.x0, F.x1 - x, z - F.z0, F.z1 - z),
                corners = [F.y1 - y, x - F.x0, F.x1 - x, z - F.z0, F.z1 - z].filter(
                  (d) => d === 0,
                ).length;
              if (edge === 0 && corners === 1 && n(x * 0.9, y * 0.9, z * 0.9) > 0.78)
                w.set(x, y, z, 0);
            }
      }

      if (ruin && erosion === 'outline') {
        // Runs along the top (in x) and down the outer sides (in y); each cut, raised or left.
        // A hash, not the smooth noise: each run's fate its own, evenly spread.
        const fate = (run: number, side: number) => {
          const h = Math.sin(run * 127.1 + side * 311.7 + seed * 19.3) * 43758.5453;
          return h - Math.floor(h);
        };
        const run = (
          from: number,
          to: number,
          side: number,
          apply: (at: number, depth: number) => void,
        ) => {
          for (let at = from, k = 0; at <= to; k++) {
            const length = 2 + Math.floor(fate(k, side + 10) * 3),
              f = fate(k, side);
            for (let i = at; i < Math.min(to + 1, at + length); i++)
              apply(i, f < 0.35 ? (f < 0.15 ? 2 : 1) : f > 0.85 ? -1 : 0);
            at += length;
          }
        };
        const column = (x: number, y: number, fill: boolean) => {
          for (let z = F.z0; z <= F.z1; z++) w.set(x, y, z, fill ? bricks(x, y, z) : 0);
        };
        run(F.x0 + 3, F.x1 - 3, 0, (x, depth) => {
          if (depth < 0) column(x, F.y1 + 1, true);
          for (let d = 0; d < depth; d++) column(x, F.y1 - d, false);
        });
        for (const [x, out, side] of [
          [F.x0, -1, 1],
          [F.x1, 1, 2],
        ] as const)
          run(F.y0 + 4, F.y1 - 3, side, (y, depth) => {
            if (depth < 0) column(x + out, y, true);
            for (let d = 0; d < depth; d++) column(x - out * d, y, false);
          });
        // The top corners stepped back: three on the left, two on the right.
        for (const [x0, step, size] of [
          [F.x0, 1, 3],
          [F.x1, -1, 2],
        ] as const)
          for (let i = 0; i < size; i++)
            for (let j = 0; j < size - i; j++) column(x0 + step * i, F.y1 - j, false);
      }

      if (detail) {
        // Lining: reinforced deepslate on the slot's inner faces, the middle of its depth.
        for (let z = F.z0 + 1; z <= F.z1 - 1; z++) {
          for (let x = open.x0; x <= open.x1; x++) {
            if (w.get(x, open.y0 - 1, z)) w.set(x, open.y0 - 1, z, id('reinforced_deepslate'));
          }
          for (let y = open.y0; y <= open.y1; y++) {
            w.set(open.x0 - 1, y, z, id('reinforced_deepslate'));
            w.set(open.x1 + 1, y, z, id('reinforced_deepslate'));
          }
        }
        // Ears: on the left jamb at mid-height, on the right at the top corner; carved, 3 proud.
        for (const [x0, step, y0] of [
          [F.x0 - 1, -1, 15],
          [F.x1 + 1, 1, F.y1 - 6],
        ] as const)
          for (let k = 0; k < 3; k++)
            for (let y = y0; y < y0 + 6; y++)
              for (let z = F.z0 + 1; z <= F.z0 + 4; z++) {
                if (n(k * 0.7, y * 0.6, z * 0.6) > 0.7 - k * 0.1 && k > 0) continue;
                w.set(
                  x0 + step * k,
                  y,
                  z,
                  id(n(y * 0.4, z * 0.4, k) > 0.5 ? 'deepslate_tiles' : 'deepslate'),
                );
              }
        // Niches along the base's front: dark 2 × 2 recesses, one deep, every five blocks.
        for (let x = 20; x <= B.x1 - 2; x += 5)
          for (let y = 3; y <= 4; y++) for (let dx = 0; dx < 2; dx++) w.set(x + dx, y, B.z1, 0);
      }

      const root = render(w, { sky: [1, 1, 1], minimum: 0.25, occlusion: 0.6 });
      const centre = [0, 6, 0] as const,
        look = [-1, 0.82, 1] as const,
        far = 150;
      const k = far / Math.hypot(...look);
      return {
        root,
        living: [],
        calm: 0,
        flicker: 0,
        sky: SKY,
        fog: { color: SKY.horizon, near: 400, far: 800 },
        camera: {
          position: [centre[0] + look[0] * k, centre[1] + look[1] * k, centre[2] + look[2] * k],
          target: centre,
          fov: 22,
          drift: 0,
        },
      };
    },
  };
}

export const FRAME_STUDY: Readonly<Record<string, StageBuilder<ChestHandles>>> = Object.freeze({
  'frame-study-a': frameStudy('a', {}),
  'frame-study-b': frameStudy('b', { ruin: true, detail: true }),
  'frame-study-c': frameStudy('c', { ruin: true, detail: true, slot: 'low' }),
  'frame-study-d': frameStudy('d', { ruin: true, detail: true, erosion: 'chips' }),
  'frame-study-e': frameStudy('e', { ruin: true, detail: true, erosion: 'outline' }),
});
