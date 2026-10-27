import type {
  FractureStyle,
  GlowStyle,
  GrowthStyle,
  WearStyle,
} from '../../../domain/chest-modifications.ts';

/**
 * Seeded 128px RGBA masks for surface modifications. Channel contract shared with the shaders:
 *   a  coverage (0 = nothing here)
 *   r  reveal order 0..255: a pixel shows once intensity (or animation progress) passes r/255
 *   g  secondary marker (wear: scratch instead of spot)
 */
export const PATTERN_SIZE = 128;

export function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const create = () => new Uint8Array(PATTERN_SIZE * PATTERN_SIZE * 4);
const wrap = (value: number) => ((value % PATTERN_SIZE) + PATTERN_SIZE) % PATTERN_SIZE;
function put(pixels: Uint8Array, x: number, y: number, order: number, marker = 0, shade = 128) {
  const index = (wrap(Math.round(y)) * PATTERN_SIZE + wrap(Math.round(x))) * 4;
  const value = Math.max(1, Math.min(255, Math.round(order * 255)));
  // Keep the earliest reveal when strokes overlap so lower intensities stay readable.
  if (pixels[index + 3] && pixels[index]! <= value) return;
  pixels[index] = value;
  pixels[index + 1] = marker;
  pixels[index + 2] = shade;
  pixels[index + 3] = 255;
}

/** Tileable value noise: bilinear between random lattice points every `cell` pixels. */
function valueNoise(next: () => number, cell: number) {
  const cells = PATTERN_SIZE / cell,
    lattice = Array.from({ length: cells * cells }, () => next());
  const at = (x: number, y: number) =>
    lattice[(((y % cells) + cells) % cells) * cells + (((x % cells) + cells) % cells)]!;
  return (x: number, y: number) => {
    const gx = x / cell,
      gy = y / cell,
      x0 = Math.floor(gx),
      y0 = Math.floor(gy);
    const fx = (gx - x0) ** 2 * (3 - 2 * (gx - x0)),
      fy = (gy - y0) ** 2 * (3 - 2 * (gy - y0));
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx,
      bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
    return top + (bottom - top) * fy;
  };
}

/**
 * Jagged branching fissures: each crack keeps a heading with small random turns (drift = how
 * nervous it is) and may fork; order grows along the crack so damage lengthens it.
 */
export function fracturePattern(style: FractureStyle, seed: number): Uint8Array {
  const pixels = create(),
    next = random(seed);
  const walk = (
    x: number,
    y: number,
    angle: number,
    length: number,
    start: number,
    depth: number,
  ) => {
    for (let step = 0; step < length; step++) {
      angle += (next() - 0.5) * style.drift * 1.6;
      x += Math.cos(angle);
      y += Math.sin(angle);
      const nx = Math.round(x),
        ny = Math.round(y);
      // Diagonal steps stay diagonal (no gap fill): one-texel cracks, as on cracked stone bricks.
      put(pixels, nx, ny, start + (((1 - start) * (step + 1)) / length) * 0.9);
      if (depth < 2 && next() < 0.12)
        walk(
          x,
          y,
          angle + (next() < 0.5 ? -1 : 1) * (0.6 + next() * 0.5),
          Math.ceil((length - step) * 0.6),
          start + ((1 - start) * step) / length,
          depth + 1,
        );
    }
  };
  for (let branch = 0; branch < style.branches; branch++) {
    walk(
      next() * PATTERN_SIZE,
      next() * PATTERN_SIZE,
      next() * Math.PI * 2,
      style.minLength + Math.floor(next() * (style.maxLength - style.minLength + 1)),
      next() * 0.35,
      0,
    );
  }
  return pixels;
}

/** Scuffs or rust: soft-edged spots revealed largest-first, plus thin bright scratches. */
export function wearPattern(style: WearStyle, seed: number): Uint8Array {
  const pixels = create(),
    next = random(seed);
  for (let spot = 0; spot < style.spots; spot++) {
    const cx = next() * PATTERN_SIZE,
      cy = next() * PATTERN_SIZE;
    const radius = style.minRadius + next() * (style.maxRadius - style.minRadius);
    const order = spot / Math.max(1, style.spots);
    for (let dy = -Math.ceil(radius); dy <= radius; dy++) {
      for (let dx = -Math.ceil(radius); dx <= radius; dx++) {
        if (dx * dx + dy * dy <= radius * radius * (0.65 + next() * 0.5))
          put(pixels, cx + dx, cy + dy, order);
      }
    }
  }
  for (let scratch = 0; scratch < style.scratches; scratch++) {
    let x = next() * PATTERN_SIZE,
      y = next() * PATTERN_SIZE;
    const slope = next() * 0.8 - 0.4,
      order = 0.2 + (0.8 * scratch) / Math.max(1, style.scratches);
    for (
      let step = 0, length = Math.max(2, Math.round(style.maxRadius * (1.5 + next() * 3)));
      step < length;
      step++
    ) {
      put(pixels, x, y, order, 255);
      x += 1;
      y += slope;
    }
  }
  return pixels;
}

const RUNE_CELL = 8;
/** Glowing runes (mirrored 5×7 glyphs on a grid), long veins or scattered sparks. */
export function glowPattern(style: GlowStyle, seed: number): Uint8Array {
  const pixels = create(),
    next = random(seed);
  if (style.pattern === 'runes') {
    // Alien-alphabet glyphs on a 4×6 grid: a spine plus two or three strokes, like table enchant glyphs.
    type Stroke = readonly [readonly [number, number], readonly [number, number]];
    const strokes: readonly Stroke[] = [
      [
        [0, 0],
        [3, 0],
      ],
      [
        [0, 5],
        [3, 5],
      ],
      [
        [0, 2],
        [3, 2],
      ],
      [
        [3, 0],
        [3, 3],
      ],
      [
        [0, 3],
        [0, 5],
      ],
      [
        [0, 0],
        [3, 3],
      ],
      [
        [3, 2],
        [0, 5],
      ],
      [
        [1, 3],
        [3, 5],
      ],
      [
        [2, 0],
        [2, 2],
      ],
    ];
    for (let cy = 0; cy < PATTERN_SIZE / RUNE_CELL; cy++) {
      for (let cx = 0; cx < PATTERN_SIZE / RUNE_CELL; cx++) {
        if (next() > style.density) continue;
        const order = next(),
          ox = cx * RUNE_CELL + 2,
          oy = cy * RUNE_CELL + 1;
        const glyph: Stroke[] = [
          [
            [next() < 0.5 ? 0 : 1, 0],
            [next() < 0.5 ? 0 : 1, 5],
          ],
        ];
        for (let count = 2 + Math.floor(next() * 2); count > 0; count--)
          glyph.push(strokes[Math.floor(next() * strokes.length)]!);
        for (const [[x0, y0], [x1, y1]] of glyph) {
          const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
          for (let step = 0; step <= steps; step++)
            put(
              pixels,
              ox + Math.round(x0 + ((x1 - x0) * step) / steps),
              oy + Math.round(y0 + ((y1 - y0) * step) / steps),
              order,
            );
        }
      }
    }
  } else if (style.pattern === 'veins') {
    const veins = Math.max(1, Math.round(style.density * 14));
    for (let vein = 0; vein < veins; vein++) {
      let x = next() * PATTERN_SIZE,
        y = next() * PATTERN_SIZE,
        angle = next() * Math.PI * 2;
      const length = 30 + Math.floor(next() * 50);
      for (let step = 0; step < length; step++) {
        put(pixels, x, y, step / length);
        angle += (next() - 0.5) * 0.7;
        x += Math.cos(angle);
        y += Math.sin(angle);
      }
    }
  } else {
    const sparks = Math.round(style.density * 160);
    for (let spark = 0; spark < sparks; spark++) {
      const x = next() * PATTERN_SIZE,
        y = next() * PATTERN_SIZE,
        order = next();
      put(pixels, x, y, order);
      if (next() < 0.3)
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ])
          put(pixels, x + dx!, y + dy!, order);
    }
  }
  return pixels;
}

/**
 * Surface growth coverage: clustered value noise, so growth spreads from patches as intensity rises.
 * Lichen is sparse dotted clumps; g marks accent pixels (lichen glow dots, blight sensors).
 */
export function growthPattern(style: GrowthStyle, seed: number): Uint8Array {
  const pixels = create(),
    next = random(seed);
  if (style.type === 'lichen') {
    // Flat carpet patches (glow lichen): a few texels across, a quarter of them glowing berries.
    const patches = valueNoise(next, 4);
    for (let y = 0; y < PATTERN_SIZE; y++) {
      for (let x = 0; x < PATTERN_SIZE; x++) {
        const order = patches(x, y) * 0.8 + next() * 0.2;
        if (order < 0.62 || next() < 0.25)
          put(
            pixels,
            x,
            y,
            (order / 0.62) * 0.9,
            next() < 0.22 ? 255 : 0,
            Math.round(next() * 255),
          );
      }
    }
    return pixels;
  }
  if (style.type === 'moss' || style.type === 'frost' || style.type === 'blight') {
    // Pattern pixels match model texels at the intended scale: clumps of ~4 texels, single-texel
    // tufts; b = leaf shade, so a clump has darker roots and lighter tips.
    const clumps = valueNoise(next, 4),
      tufts = valueNoise(next, 2);
    for (let y = 0; y < PATTERN_SIZE; y++) {
      for (let x = 0; x < PATTERN_SIZE; x++) {
        const order = Math.min(
          1,
          Math.max(0, clumps(x, y) * 0.65 + tufts(x, y) * 0.35 + (next() - 0.5) * 0.12),
        );
        const shade = Math.min(1, Math.max(0, (1 - order) * 0.7 + next() * 0.45 - 0.1));
        if (style.type === 'frost' && next() < 0.45) continue; // frost is a speckle of crystals, not a sheet
        put(
          pixels,
          x,
          y,
          order,
          style.type === 'blight' && next() < 0.025 ? 255 : 0,
          Math.round(shade * 255),
        );
      }
    }
    return pixels;
  }
  // Geometry growths (crystals, vines, cobweb, snow) have no surface mask.
  return pixels;
}

/** Colour RGBA textures for growth geometry (vines, cobweb, snow), 32px, transparent where empty. */
export const SPRITE_SIZE = 32;
function sprite(
  paint: (set: (x: number, y: number, shade: number) => void, next: () => number) => void,
  color: string,
  seed: number,
) {
  const pixels = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4),
    next = random(seed);
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16));
  paint((x, y, shade) => {
    if (x < 0 || y < 0 || x >= SPRITE_SIZE || y >= SPRITE_SIZE) return;
    const index = (Math.floor(y) * SPRITE_SIZE + Math.floor(x)) * 4;
    pixels[index] = Math.min(255, r! * shade);
    pixels[index + 1] = Math.min(255, g! * shade);
    pixels[index + 2] = Math.min(255, b! * shade);
    pixels[index + 3] = 255;
  }, next);
  return pixels;
}

/** One hanging strand: wandering 1px stem, leaf pairs, uneven length. Row 0 is the top. */
export function vineSprite(color: string, seed: number): Uint8Array {
  return sprite(
    (set, next) => {
      let x = 12 + Math.floor(next() * 8);
      const length = 18 + Math.floor(next() * 14);
      for (let y = 0; y < length; y++) {
        set(x, y, 0.8 + next() * 0.2);
        if (y % 3 === 1) {
          const side = (y / 3) % 2 < 1 ? -1 : 1;
          for (const [dx, dy] of [
            [side, 0],
            [side * 2, 0],
            [side, 1],
            [side * 2, -1],
          ])
            set(x + dx!, y + dy!, 0.6 + next() * 0.5);
        }
        if (next() < 0.2) x += next() < 0.5 ? -1 : 1;
      }
    },
    color,
    seed,
  );
}

/** Corner web on a 16px logical grid (2×2 sprite pixels): radial threads plus straight chords between them. */
export function cobwebSprite(color: string, seed: number): Uint8Array {
  return sprite(
    (draw, next) => {
      const set = (x: number, y: number, shade: number) => {
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ])
          draw(x * 2 + dx!, y * 2 + dy!, shade);
      };
      const line = (x0: number, y0: number, x1: number, y1: number, shade: number) => {
        const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
        for (let step = 0; step <= steps; step++)
          set(
            Math.round(x0 + ((x1 - x0) * step) / steps),
            Math.round(y0 + ((y1 - y0) * step) / steps),
            shade,
          );
      };
      const angles = [8, 27, 45, 63, 82].map(
        (degrees) => ((degrees + (next() - 0.5) * 8) * Math.PI) / 180,
      );
      for (const angle of angles) line(0, 0, Math.cos(angle) * 15, Math.sin(angle) * 15, 0.95);
      for (const radius of [4, 8, 12].map((value) => value + Math.round(next() * 2 - 1))) {
        for (let index = 1; index < angles.length; index++) {
          if (next() < 0.15) continue; // a few torn strands
          const a = angles[index - 1]!,
            b = angles[index]!;
          line(
            Math.cos(a) * radius,
            Math.sin(a) * radius,
            Math.cos(b) * radius,
            Math.sin(b) * radius,
            0.8,
          );
        }
      }
    },
    color,
    seed,
  );
}

/** Snow cap top: bright with faint cold blue grains, so it reads as packed snow, not paint. */
export function snowSprite(color: string, seed: number): Uint8Array {
  return sprite(
    (set, next) => {
      // 8×8 texel tile drawn as 4×4 blocks; the slab repeats it once per 8 texels.
      for (let by = 0; by < 8; by++)
        for (let bx = 0; bx < 8; bx++) {
          const shade = next() < 0.18 ? 0.84 : 0.94 + next() * 0.06;
          for (let y = 0; y < 4; y++)
            for (let x = 0; x < 4; x++) set(bx * 4 + x, by * 4 + y, shade);
        }
    },
    color,
    seed,
  );
}
