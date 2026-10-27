/**
 * A stand-in resource pack for the Minecraft importer (tools/mc-import): our own 16×16 tiles under
 * the game's tile names and layouts (the lantern's parts where the game's model reads them; grass
 * tops and leaves grey, for the mapping's tint), painted here — no Mojang art, CC0. With a real
 * resource pack (the game's own, extracted, or a licensed one) the same mapping gives the game's look.
 *
 *   node scripts/packs/make-mc-tiles.mjs [out dir]     default artifacts/mc-import/resource-pack
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { encodeImage } from '../../tools/mc-import/textures.ts';

const out = resolve(
  process.argv[2] ??
    join(import.meta.dirname, '..', '..', 'artifacts', 'mc-import', 'resource-pack'),
);
const dir = join(out, 'assets', 'minecraft', 'textures', 'block');
const T = 16;

let seed = 1;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const hex = (h) => {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255];
};
const shade = (h, f) =>
  hex(h).map((c, i) => (i < 3 ? Math.max(0, Math.min(255, Math.round(c * f))) : c));

function tile(paint) {
  const rgba = new Uint8Array(T * T * 4);
  const px = (x, y, c) => {
    if (x < 0 || y < 0 || x >= T || y >= T) return;
    rgba.set(c === null ? [0, 0, 0, 0] : typeof c === 'string' ? hex(c) : c, (y * T + x) * 4);
  };
  paint(px);
  return { width: T, height: T, rgba };
}
/** Value noise in a palette: patches of shades, a little grain. */
const noise =
  (base, spread = 0.12, cell = 4) =>
  (px) => {
    const g = Array.from({ length: (T / cell + 1) ** 2 }, () => rand()),
      n = T / cell + 1;
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        const gx = x / cell,
          gy = y / cell,
          cx = Math.floor(gx),
          cy = Math.floor(gy),
          fx = gx - cx,
          fy = gy - cy;
        const a = g[cy * n + cx],
          b = g[cy * n + cx + 1],
          c = g[(cy + 1) * n + cx],
          d = g[(cy + 1) * n + cx + 1];
        const v = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
        px(x, y, shade(base, 1 - spread + 2 * spread * (v * 0.8 + rand() * 0.2)));
      }
  };
const bricks =
  (base, mortar, rows = 4, width = 8) =>
  (px) => {
    noise(base, 0.08)(px);
    const h = T / rows;
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        const row = Math.floor(y / h),
          off = row % 2 ? width / 2 : 0;
        if (y % h === h - 1 || (x + off) % width === width - 1)
          px(x, y, shade(mortar, 0.9 + rand() * 0.2));
        else if (y % h === 0) px(x, y, shade(base, 1.12));
      }
  };
/** Hairline cracks: short diagonal runs a shade darker, never closed shapes (those read as glyphs). */
const cracks =
  (color, n = 2) =>
  (px) => {
    for (let i = 0; i < n; i++) {
      let x = 2 + Math.floor(rand() * 12),
        y = 1 + Math.floor(rand() * 6);
      const dx = rand() < 0.5 ? 1 : -1;
      for (let k = 0; k < 6; k++) {
        px(x, y, color);
        if (rand() < 0.6) x += dx;
        y++;
      }
    }
  };
/** Moss in soft patches (thresholded value noise), heavier at the top. */
const moss = (px) => {
  const n = 5,
    g = Array.from({ length: n * n }, () => rand());
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const gx = x / 4,
        gy = y / 4,
        cx = Math.floor(gx),
        cy = Math.floor(gy),
        fx = gx - cx,
        fy = gy - cy,
        at = (i, j) => g[(j % n) * n + (i % n)];
      const v =
        at(cx, cy) * (1 - fx) * (1 - fy) +
        at(cx + 1, cy) * fx * (1 - fy) +
        at(cx, cy + 1) * (1 - fx) * fy +
        at(cx + 1, cy + 1) * fx * fy;
      if (v + (8 - y) * 0.02 > 0.58) px(x, y, shade('#5b7a3a', 0.85 + rand() * 0.3));
    }
};
const polished = (base, edge) => (px) => {
  noise(base, 0.04, 8)(px);
  for (let i = 0; i < T; i++) {
    px(i, 0, shade(base, 1.15));
    px(0, i, shade(base, 1.15));
    px(i, T - 1, edge);
    px(T - 1, i, edge);
  }
};
const tiles =
  (base, joint, cell = 8) =>
  (px) => {
    noise(base, 0.06)(px);
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++)
        if (y % cell === cell - 1 || x % cell === cell - 1) px(x, y, joint);
  };
const cobble = (base, joint) => (px) => {
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) px(x, y, joint);
  for (let i = 0; i < 9; i++) {
    const cx = (i % 3) * 5.5 + 2 + rand() * 2,
      cy = Math.floor(i / 3) * 5.5 + 2 + rand() * 2,
      r = 2 + rand() * 1.3,
      f = 0.85 + rand() * 0.3;
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 < r * r)
          px(x, y, shade(base, f + (x - cx < 0 && y - cy < 0 ? 0.1 : 0)));
  }
};
const planks = (base, dark) => (px) => {
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++)
      px(
        x,
        y,
        shade(base, 0.92 + 0.08 * Math.sin(x * 1.7 + Math.floor(y / 4) * 3) + rand() * 0.05),
      );
  for (let x = 0; x < T; x++) {
    px(x, 3, dark);
    px(x, 7, dark);
    px(x, 11, dark);
    px(x, 15, dark);
  }
  for (const [x, y] of [
    [4, 0],
    [12, 4],
    [2, 8],
    [9, 12],
  ])
    for (let k = 0; k < 3; k++) px(x, y + k, dark);
};
const bark = (base, dark) => (px) => {
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const streak = (x * 7 + Math.floor(y / 5) * 3) % 5 === 0;
      px(x, y, streak ? shade(dark, 0.9 + rand() * 0.2) : shade(base, 0.85 + rand() * 0.3));
    }
};
const rings = (bark, wood, ring) => (px) => {
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      px(
        x,
        y,
        d > 6.5
          ? shade(bark, 0.9 + rand() * 0.2)
          : Math.floor(d) % 2
            ? shade(ring, 0.95 + rand() * 0.1)
            : shade(wood, 0.95 + rand() * 0.1),
      );
    }
};
const leaves = (grey) => (px) => {
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) px(x, y, rand() < 0.14 ? null : shade(grey, 0.7 + rand() * 0.45));
};
const glass = (color, alpha) => (px) => {
  const [r, g, b] = hex(color);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const edge = x === 0 || y === 0 || x === T - 1 || y === T - 1,
        glint = (x === y + 3 || x === y + 4) && x > 3 && x < 10;
      px(x, y, [
        r,
        g,
        b,
        edge ? Math.min(255, alpha + 60) : glint ? Math.min(255, alpha + 30) : alpha,
      ]);
    }
};
const trapdoor = (base, dark) => (px) => {
  planks(base, dark)(px);
  for (let i = 0; i < T; i++) {
    px(i, 0, dark);
    px(0, i, dark);
    px(i, T - 1, dark);
    px(T - 1, i, dark);
  }
  for (const [x0, y0] of [
    [3, 3],
    [9, 3],
    [3, 9],
    [9, 9],
  ])
    for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) px(x, y, null);
};

const TILES = {
  dirt: noise('#866043', 0.14),
  grass_block_top: noise('#9a9a9a', 0.16),
  grass_block_side: (px) => {
    noise('#866043', 0.14)(px);
    for (let x = 0; x < T; x++) {
      const d = 3 + Math.floor(rand() * 2.5);
      for (let y = 0; y < d; y++) px(x, y, shade('#6a9b3e', 0.85 + rand() * 0.3));
    }
  },
  stone_bricks: bricks('#7a7a7a', '#555555'),
  mossy_stone_bricks: (px) => {
    bricks('#767676', '#525252')(px);
    moss(px);
  },
  cracked_stone_bricks: (px) => {
    bricks('#767676', '#525252')(px);
    cracks('#555555')(px);
  },
  cobblestone: cobble('#7f7f7f', '#535353'),
  cobbled_deepslate: cobble('#4d4d51', '#2d2d31'),
  blackstone: noise('#2c252b', 0.18, 2),
  blackstone_top: noise('#2f282e', 0.14, 4),
  polished_blackstone: polished('#35303b', '#221e26'),
  cracked_polished_blackstone_bricks: (px) => {
    bricks('#302b34', '#1d1a21', 4, 8)(px);
    cracks('#211d24')(px);
  },
  polished_deepslate: polished('#484849', '#303031'),
  deepslate_tiles: tiles('#3c3c3e', '#232325', 8),
  deepslate_bricks: bricks('#464648', '#2b2b2d'),
  polished_andesite: polished('#848685', '#6a6c6b'),
  polished_diorite: polished('#c4c4c6', '#a4a4a8'),
  netherrack: noise('#6f3232', 0.2, 2),
  shroomlight: (px) => {
    noise('#f19645', 0.12, 2)(px);
    for (let i = 0; i < 6; i++) px(Math.floor(rand() * T), Math.floor(rand() * T), '#ffd88a');
  },
  spruce_planks: planks('#735531', '#4f3a21'),
  dark_oak_planks: planks('#432b14', '#2c1c0c'),
  oak_planks: planks('#a2834f', '#7a6038'),
  spruce_log: bark('#3a2610', '#24170a'),
  spruce_log_top: rings('#3a2610', '#6e5130', '#5a4126'),
  stripped_spruce_log: bark('#735a37', '#5c4628'),
  stripped_spruce_log_top: rings('#735a37', '#7a5f3b', '#664d2e'),
  spruce_leaves: leaves('#8c8c8c'),
  birch_leaves: leaves('#9a9a9a'),
  oak_leaves: leaves('#929292'),
  spruce_trapdoor: trapdoor('#6a4d2b', '#3f2d17'),
  dark_oak_trapdoor: trapdoor('#4a3017', '#2a1a0a'),
  black_stained_glass: glass('#191919', 150),
  red_stained_glass: glass('#993333', 150),
  orange_stained_glass: glass('#d87f33', 150),
  yellow_stained_glass: glass('#e5e533', 150),
  barrel_side: (px) => {
    planks('#86643a', '#5a4024')(px);
    for (const y of [2, 13]) for (let x = 0; x < T; x++) px(x, y, '#3a3a3e');
  },
  barrel_top: (px) => {
    rings('#5a4024', '#86643a', '#7a5a34')(px);
    for (let i = 0; i < T; i++) {
      px(i, 0, '#3a3a3e');
      px(0, i, '#3a3a3e');
      px(i, T - 1, '#3a3a3e');
      px(T - 1, i, '#3a3a3e');
    }
  },
  barrel_top_open: (px) => {
    TILES.barrel_top(px);
    for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) px(x, y, '#1a120a');
  },
  barrel_bottom: rings('#5a4024', '#7a5a34', '#6e5130'),
  // The game's lantern tile: body sides at (0,2)-(6,9), body ends (0,9)-(6,15), cap sides (1,0)-(5,2),
  // cap ends (1,10)-(5,14), handle (11,1)-(14,6); the rest clear.
  lantern: (px) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) px(x, y, null);
    for (let y = 2; y < 9; y++)
      for (let x = 0; x < 6; x++)
        px(
          x,
          y,
          x === 0 || x === 5 || y === 2 || y === 8
            ? '#3c3f47'
            : y > 3 && y < 8 && x > 1 && x < 4
              ? '#fff0a8'
              : '#f5b448',
        );
    for (let y = 9; y < 15; y++)
      for (let x = 0; x < 6; x++)
        px(x, y, x === 0 || x === 5 || y === 9 || y === 14 ? '#3c3f47' : '#4c505a');
    for (let y = 0; y < 2; y++) for (let x = 1; x < 5; x++) px(x, y, '#4c505a');
    for (let y = 1; y < 6; y++) for (let x = 11; x < 14; x++) px(x, y, '#3c3f47');
  },
  fire_0: (px) => {
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        const h = 7 + 6 * Math.abs(Math.sin(x * 1.3 + 1)) + rand() * 2,
          up = T - 1 - y;
        px(x, y, up > h ? null : up > h - 3 ? '#f7d34c' : up > h - 7 ? '#ef8a1f' : '#c8461a');
      }
  },
};

await mkdir(dir, { recursive: true });
for (const [name, paint] of Object.entries(TILES)) {
  seed = [...name].reduce((s, c) => (s * 31 + c.charCodeAt(0)) % 2147483647, 7) || 1;
  await writeFile(join(dir, `${name}.png`), encodeImage(tile(paint)));
}
await writeFile(
  join(out, 'pack.mcmeta'),
  `${JSON.stringify({ pack: { pack_format: 9, description: 'Voxel Vault stand-in tiles (CC0), painted by scripts/packs/make-mc-tiles.mjs' } }, null, 1)}\n`,
);
console.log(`${dir}: ${Object.keys(TILES).length} tiles`);
