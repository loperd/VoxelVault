import {
  BlockWorld,
  type GuestLight,
  type Stage,
  type StageBuilder,
} from '../../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../../application/ports/chest-handles.ts';
import { id, noise, onTop, render } from './kit.ts';

/**
 * "Порог Древнего города" (artifacts/art-direction/ancient/intent.md): the ancient city's frame —
 * a colossal low ring of deepslate with broken edges — and the chest on its threshold. Two
 * compositions with different spaces: V1 the frame beyond the chest at the top of a stepped
 * plinth, seen on axis; V2 the camera inside the frame's opening, looking out along a causeway over
 * a chasm at the city's towers. Cold soul light (second colour) on the stone, one warm cluster of
 * candles at the chest that is also the chest's key.
 */
const X = 72,
  Y = 44,
  Z = 80,
  CX = 36,
  FRAME_Z = 24,
  BASE = 9;
const FRAME = { half: 12, height: 14, open: { half: 8, from: 3, to: 9 } };
const MESH = {
  sky: [0, 0, 0] as const,
  glow: [1, 0.66, 0.36] as const,
  glow2: [0.3, 0.78, 1] as const,
  minimum: 0.025,
  occlusion: 0.85,
};

type Noise = (x: number, y: number, z: number) => number;

/** Fill the world with deepslate and open a cavern too wide to see the walls of. */
function cavern(w: BlockWorld, n: Noise, floor: (x: number, z: number) => number): void {
  for (let z = 0; z < Z; z++)
    for (let y = 0; y < Y; y++)
      for (let x = 0; x < X; x++) {
        const d =
          ((x - CX) / 35) ** 2 +
          ((y - 20) / 23) ** 2 +
          ((z - 40) / 40) ** 2 +
          (n(x * 0.1, y * 0.1, z * 0.1) - 0.5) * 0.3;
        const ground = floor(x, z);
        w.set(
          x,
          y,
          z,
          d < 1 && y > ground
            ? 0
            : id(
                y === ground && n(x * 0.3, 1, z * 0.3) > 0.62
                  ? 'sculk'
                  : y === ground
                    ? 'deepslate_tiles'
                    : 'deepslate',
              ),
        );
      }
}

/** The frame: a ring of bricks, lined with reinforced deepslate, its outer edges broken; ears at the sides. */
function frame(w: BlockWorld, n: Noise, lanterns: boolean): void {
  const { half, height, open } = FRAME;
  for (let y = BASE; y < BASE + height; y++)
    for (let x = CX - half; x <= CX + half; x++)
      for (let z = FRAME_Z - 1; z <= FRAME_Z + 1; z++) {
        const dx = Math.abs(x - CX),
          dy = y - BASE;
        if (dx < open.half && dy >= open.from && dy <= open.to) continue;
        const lining =
          (dx === open.half && dy >= open.from && dy <= open.to) ||
          ((dy === open.from - 1 || dy === open.to + 1) && dx <= open.half);
        // Broken more towards the top corners: the ruin's silhouette, not a clean rectangle.
        const ruin = Math.max(0, dx - half + 4) / 4 + Math.max(0, dy - height + 5) / 5;
        if (ruin > 0 && n(x * 0.45, y * 0.45, z * 0.9) < ruin * 0.55) continue;
        w.set(
          x,
          y,
          z,
          id(
            lining
              ? 'reinforced_deepslate'
              : n(x * 0.3, y * 0.3, z) > 0.7
                ? 'deepslate_tiles'
                : 'deepslate_bricks',
          ),
        );
      }
  for (const side of [-1, 1])
    for (let y = BASE + 4; y < BASE + 9; y++)
      for (let k = 1; k <= 2; k++)
        for (let z = FRAME_Z - 2; z <= FRAME_Z + 2; z++) {
          if (n(y * 0.5, k, z * 0.5) > 0.72) continue;
          w.set(CX + side * (half + k), y, z, id('deepslate_tiles'));
        }
  // Soul lanterns on chains from the opening's lintel.
  if (lanterns)
    for (const dx of [-5, 0, 5]) {
      w.set(CX + dx, BASE + open.to, FRAME_Z, id('chain'));
      w.set(CX + dx, BASE + open.to - 1, FRAME_Z, id('soul_lantern'));
    }
}

/** A tower of the city: a square brick shaft, a broken crown, a soul lantern on top. */
function tower(
  w: BlockWorld,
  n: Noise,
  x0: number,
  z0: number,
  base: number,
  height: number,
): void {
  for (let y = base; y < base + height; y++)
    for (let x = x0; x < x0 + 3; x++)
      for (let z = z0; z < z0 + 3; z++) {
        if (y > base + height - 3 && n(x * 0.7, y * 0.7, z * 0.7) > 0.55) continue;
        w.set(x, y, z, id('deepslate_bricks'));
      }
  w.set(x0 + 1, base + height, z0 + 1, id('soul_lantern'));
}

function candles(w: BlockWorld, at: readonly (readonly [number, number, number])[]): void {
  for (const c of at) w.set(...c, id('candles'));
}

/** The chest's light: cold soul-lit fill, the key warm, from the candles the scene shows. */
function chestLight(
  anchor: readonly [number, number, number],
  candle: readonly [number, number, number],
): GuestLight {
  return {
    sky: '#3d6c8a',
    ground: '#0c1418',
    key: '#ffb46a',
    from: [candle[0] - anchor[0], candle[1] + 0.4 - anchor[1], candle[2] - anchor[2]],
    keyStrength: 5,
    fillStrength: 0.9,
  };
}

// Haze a little lighter than the dark: far things go pale, so near dark forms stand against them.
// The sky only shows through cracks in the vault: the haze's colour, or the cracks are black holes.
const ATMOSPHERE = {
  sky: { top: '#132330', horizon: '#132330', bottom: '#132330' },
  fog: { color: '#132330', near: 14, far: 80 },
};

/** V1 «Порог»: on axis, low; the plinth's steps and a cyan line on the floor lead up to the chest, the frame beyond. */
export const ANCIENT_THRESHOLD: StageBuilder<ChestHandles> = {
  id: 'art-ancient-threshold-v1',
  build(seed): Stage<ChestHandles> {
    const n = noise(seed),
      w = new BlockWorld(X, Y, Z, [-CX, -BASE, -30]);
    cavern(w, n, () => 5);
    // The plinth: three layers, the frame on the back of the top; steps down the front on the axis.
    for (const [y, hx, z0, z1] of [
      [6, 17, 15, 33],
      [7, 15, 16, 32],
      [8, 13, 17, 31],
    ] as const)
      for (let z = z0; z <= z1; z++)
        for (let x = CX - hx; x <= CX + hx; x++) w.set(x, y, z, id('deepslate_bricks'));
    for (let x = CX - 3; x <= CX + 3; x++)
      for (const [y, z] of [
        [8, 32],
        [7, 33],
        [6, 34],
      ] as const)
        w.set(x, y, z, id('deepslate_brick_stairs_n'));
    frame(w, n, true);
    // Lanterns on the plinth's front corners light the frame's face from below and the side.
    for (const x of [CX - 12, CX + 12]) w.set(x, 9, 31, id('soul_lantern'));
    for (const [x, z, h] of [
      [12, 6, 18],
      [20, 3, 24],
      [50, 4, 21],
      [57, 8, 15],
      [28, 1, 28],
      [43, 2, 26],
    ] as const)
      tower(w, n, x, z, 6, h);
    for (let z = 35; z < 70; z++) w.set(CX, 6, z, id('soul_strip'));
    const chest = [CX, 8, 29] as const,
      candle = [CX + 2, 9, 30] as const;
    candles(w, [candle, [CX - 2, 9, 28]]);
    const root = render(w, MESH),
      anchor = onTop(w, ...chest);
    return {
      root,
      living: [],
      calm: 0,
      flicker: 0.08,
      ...ATMOSPHERE,
      // Three-quarters, close: the frame's thickness and broken corners show, the chest a real object.
      camera: {
        position: [anchor[0] + 3.5, anchor[1] + 1.6, anchor[2] + 11],
        target: [anchor[0] - 0.4, anchor[1] + 0.8, anchor[2]],
        fov: 66,
        drift: 0,
        focus: [0.5, 0.64],
      },
      anchor,
      ground: { floor: anchor[1] },
      light: chestLight(anchor, onTop(w, ...candle)),
    };
  },
};

/** V2 «Изнутри проёма»: from inside the frame's opening, out along a causeway over a chasm to the towers. */
export const ANCIENT_OUTWARD: StageBuilder<ChestHandles> = {
  id: 'art-ancient-outward-v1',
  build(seed): Stage<ChestHandles> {
    const n = noise(seed),
      w = new BlockWorld(X, Y, Z, [-CX, -BASE, -30]);
    cavern(w, n, (_, z) => (z < 29 ? 5 : 0));
    for (let z = 14; z <= 28; z++)
      for (let y = 6; y <= 8; y++)
        for (let x = CX - 14; x <= CX + 14; x++) w.set(x, y, z, id('deepslate_bricks'));
    // Unlit: from inside, the frame is a dark vignette, not a lit surface.
    frame(w, n, false);
    // The causeway: three wide, slab-edged, out over the chasm; broken off just past the chest.
    for (let z = 29; z <= 40; z++)
      for (let x = CX - 1; x <= CX + 1; x++) {
        w.set(x, 8, z, id('deepslate_bricks'));
        if (x !== CX && z % 3 === 0) w.set(x, 9, z, id('deepslate_brick_slab'));
      }
    for (let z = 31; z <= 39; z += 4)
      for (let y = 1; y < 8; y++) w.set(CX, y, z, id('deepslate_bricks'));
    for (const [x, z, h] of [
      [18, 46, 22],
      [26, 58, 30],
      [44, 50, 26],
      [52, 62, 20],
      [33, 70, 34],
      [10, 64, 16],
      [60, 44, 14],
    ] as const) {
      tower(w, n, x, z, 1, h);
      // A lit window halfway up, so each tower reads in the dark.
      w.set(x + 1, Math.round(h * 0.55), z + 3, id('soul_lantern'));
    }
    for (let z = 30; z < 78; z += 1)
      if (n(z * 0.3, 2, 0) > 0.45)
        w.set(CX + Math.round((n(z * 0.1, 5, 1) - 0.5) * 20), 1, z, id('soul_strip'));
    const chest = [CX, 8, 33] as const,
      candle = [CX + 1, 9, 32] as const;
    candles(w, [candle, [CX - 1, 9, 34]]);
    const root = render(w, MESH),
      anchor = onTop(w, ...chest);
    return {
      root,
      living: [],
      calm: 0,
      flicker: 0.08,
      ...ATMOSPHERE,
      // Ten blocks behind the frame, high in the opening, so the line to the chest clears the sill:
      // the ring is the picture's border.
      camera: {
        position: [anchor[0] + 0.5, anchor[1] + 7.6, FRAME_Z - 30 - 10],
        target: [anchor[0], anchor[1] + 0.6, anchor[2]],
        fov: 64,
        drift: 0,
        focus: [0.5, 0.62],
      },
      anchor,
      ground: { floor: anchor[1] },
      light: chestLight(anchor, onTop(w, ...candle)),
    };
  },
};
