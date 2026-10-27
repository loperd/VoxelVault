/**
 * Makes the binary files of the two technical packs — their PNG tiles, GLB models and structure.u16,
 * all painted and modelled here (own work, CC0), no game assets:
 * - packs/sample-ruin: the format shown, a small ruin with a model of its own; nothing diagnostic;
 * - packs/color-calibration: known colours to measure — the same tile on a block and on GLB plates
 *   (unlit by factor, unlit by texture, lit), a block with a letter on every side, even light.
 * pack.json of each is data written by hand and is not touched: what a pack shows, where things
 * stand, its cameras and light are edited there.
 *
 *   node scripts/packs/make-sample-ruin.mjs [packs]           (both packs, into <packs>/sample-ruin and <packs>/color-calibration)
 *   node scripts/packs/make-sample-ruin.mjs --variants <dir>   (other tiles and models, to swap in for a demo)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

// ── PNG ──────────────────────────────────────────────────────────────────────
function png(pixels /* 16×16 [r,g,b,a] rows from the top */) {
  const raw = Buffer.alloc(16 * (1 + 16 * 4));
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const [r, g, b, a = 255] = pixels[y][x];
      raw.set([r, g, b, a], y * 65 + 1 + x * 4);
    }
  const chunk = (name, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length);
    head.write(name, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16);
  ihdr.writeUInt32BE(16, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (c) => [
  parseInt(c.slice(1, 3), 16),
  parseInt(c.slice(3, 5), 16),
  parseInt(c.slice(5, 7), 16),
];
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function tile(seed, paint) {
  const rand = seeded(seed),
    pixels = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => [0, 0, 0, 0]));
  paint((x, y, c) => {
    if (x >= 0 && y >= 0 && x < 16 && y < 16)
      pixels[y][x] = typeof c === 'string' ? [...hex(c), 255] : c;
  }, rand);
  return png(pixels);
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const fill = (colors) => (px, rand) => {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, pick(rand, colors));
};
const bricks = (stone, mortar, extra) => (px, rand) => {
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const course = y >> 2,
        joint = (x + (course % 2) * 4) % 8 === 7 || y % 4 === 3;
      px(x, y, joint ? mortar : pick(rand, stone));
    }
  extra?.(px, rand);
};
const moss = (px, rand) => {
  for (let i = 0; i < 46; i++) {
    const x = Math.floor(rand() * 16),
      y = Math.floor(rand() * 9 * rand());
    px(x, y, pick(rand, ['#4f6b2e', '#5e7d35', '#3f5626']));
  }
};
// A 3×5 letter for the compass block: which side is which, at a glance.
const LETTERS = {
  N: ['101', '111', '111', '111', '101'],
  S: ['111', '100', '111', '001', '111'],
  E: ['111', '100', '111', '100', '111'],
  W: ['101', '101', '111', '111', '101'],
  U: ['101', '101', '101', '101', '111'],
  D: ['110', '101', '101', '101', '110'],
};
const compass = (letter, ink) => (px, rand) => {
  fill(['#8d8478', '#958c80', '#857c70'])(px, rand);
  for (let i = 0; i < 16; i++) {
    px(i, 0, '#5d564e');
    px(i, 15, '#5d564e');
    px(0, i, '#5d564e');
    px(15, i, '#5d564e');
  }
  LETTERS[letter].forEach((row, y) =>
    [...row].forEach((on, x) => {
      if (on === '1')
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) px(5 + x * 2 + dx, 3 + y * 2 + dy, ink);
    }),
  );
};

const TILES = {
  ruin_bricks: tile(1, bricks(['#7a736b', '#857d74', '#6f6861', '#8c847a'], '#4a4540')),
  ruin_moss: tile(2, bricks(['#7a736b', '#857d74', '#6f6861'], '#4a4540', moss)),
  ruin_floor: tile(3, (px, rand) => {
    fill(['#9a9085', '#a39a8e', '#918779'])(px, rand);
    for (let i = 0; i < 16; i++) {
      px(i, 7, '#6b645c');
      px(7, i, '#6b645c');
      px(i, 15, '#6b645c');
      px(15, i, '#6b645c');
    }
  }),
  ruin_turf: tile(4, fill(['#4c7a32', '#558838', '#467030', '#5d9140'])),
  ruin_soil: tile(5, (px, rand) => {
    fill(['#6b4a32', '#5e412c', '#77543a'])(px, rand);
    for (let x = 0; x < 16; x++)
      for (let y = 0; y < 2 + Math.floor(rand() * 3); y++)
        px(x, y, pick(rand, ['#4c7a32', '#558838']));
  }),
  log_bark: tile(6, (px, rand) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        px(x, y, x % 4 === 0 ? '#3d2a1a' : pick(rand, ['#5a3f27', '#634630', '#523822']));
  }),
  log_end: tile(7, (px) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const r = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
        px(x, y, r > 6.5 ? '#4b331f' : Math.floor(r) % 2 ? '#a07a4c' : '#b68d5a');
      }
  }),
  ruin_planks: tile(8, (px, rand) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        px(x, y, y % 4 === 3 ? '#5a3d22' : pick(rand, ['#9c6f40', '#a87a48', '#946838']));
  }),
  ruin_lamp: tile(9, (px, rand) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const rim = x < 2 || y < 2 || x > 13 || y > 13;
        px(x, y, rim ? '#3b3026' : pick(rand, ['#ffd27a', '#ffe3a1', '#f7b955']));
      }
  }),
};

const CALIBRATION_TILES = {
  compass_n: tile(10, compass('N', '#2f5fa8')),
  compass_s: tile(11, compass('S', '#a8322f')),
  compass_e: tile(12, compass('E', '#2f8a45')),
  compass_w: tile(13, compass('W', '#c9a22b')),
  compass_u: tile(14, compass('U', '#f2f2f2')),
  compass_d: tile(15, compass('D', '#1b1b1b')),
  // Flat, known colours for the colour check (docs §4.2, 5): the same values the reference model uses.
  ref_orange: tile(16, (px) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, '#c86432');
  }),
  ref_grey: tile(17, (px) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, '#808080');
  }),
};

const VARIANT_TILES = {
  // The same name, other bricks: blue-glazed. Swapped in, the walls change; no code changes.
  ruin_bricks: tile(21, bricks(['#3f5f86', '#486a93', '#36557a', '#52749c'], '#1f2c3d')),
};

// ── GLB ──────────────────────────────────────────────────────────────────────
/** A box as 24 vertices (flat normals, 0..1 UVs per face), centred on `at`, `size` across. */
function box(at, size) {
  const [cx, cy, cz] = at,
    [hx, hy, hz] = size.map((v) => v / 2),
    positions = [],
    normals = [],
    uvs = [],
    indices = [];
  const faces = [
    [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
  ];
  for (const [n, u, v] of faces) {
    const start = positions.length / 3;
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      positions.push(
        cx + (n[0] + u[0] * a + v[0] * b) * hx,
        cy + (n[1] + u[1] * a + v[1] * b) * hy,
        cz + (n[2] + u[2] * a + v[2] * b) * hz,
      );
      normals.push(...n);
      uvs.push((a + 1) / 2, 1 - (b + 1) / 2);
    }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  return { positions, normals, uvs, indices };
}
function merge(boxes) {
  const out = { positions: [], normals: [], uvs: [], indices: [] };
  for (const b of boxes) {
    const base = out.positions.length / 3;
    out.positions.push(...b.positions);
    out.normals.push(...b.normals);
    out.uvs.push(...b.uvs);
    out.indices.push(...b.indices.map((i) => i + base));
  }
  return out;
}
const linear = (c) =>
  hex(c).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });

/**
 * A GLB of meshes, one node each: `parts` = [{ geometry, material: { color (sRGB hex), metallic,
 * roughness, emissive?, unlit?, texture? (PNG bytes) } }]. glTF colour factors are linear.
 */
function glb(parts) {
  const chunks = [],
    views = [],
    accessors = [],
    meshes = [],
    materials = [],
    nodes = [],
    images = [],
    textures = [];
  let length = 0;
  const view = (data, target) => {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      pad = (4 - (bytes.length % 4)) % 4;
    views.push({
      buffer: 0,
      byteOffset: length,
      byteLength: bytes.length,
      ...(target ? { target } : {}),
    });
    chunks.push(bytes, Buffer.alloc(pad));
    length += bytes.length + pad;
    return views.length - 1;
  };
  const accessor = (data, type, componentType, target, minmax) => {
    accessors.push({
      bufferView: view(data, target),
      componentType,
      count: data.length / { SCALAR: 1, VEC2: 2, VEC3: 3 }[type],
      type,
      ...minmax,
    });
    return accessors.length - 1;
  };
  const extensions = new Set();
  parts.forEach(({ geometry: g, material: m, name }, i) => {
    const p = new Float32Array(g.positions),
      min = [0, 1, 2].map((k) => Math.min(...g.positions.filter((_, j) => j % 3 === k))),
      max = [0, 1, 2].map((k) => Math.max(...g.positions.filter((_, j) => j % 3 === k)));
    const attributes = {
      POSITION: accessor(p, 'VEC3', 5126, 34962, { min, max }),
      NORMAL: accessor(new Float32Array(g.normals), 'VEC3', 5126, 34962),
      TEXCOORD_0: accessor(new Float32Array(g.uvs), 'VEC2', 5126, 34962),
    };
    const indices = accessor(new Uint16Array(g.indices), 'SCALAR', 5123, 34963);
    const pbr = {
      baseColorFactor: [...linear(m.color), 1],
      metallicFactor: m.metallic ?? 0,
      roughnessFactor: m.roughness ?? 0.8,
    };
    if (m.texture) {
      images.push({ bufferView: view(new Uint8Array(m.texture)), mimeType: 'image/png' });
      textures.push({ source: images.length - 1, sampler: 0 });
      pbr.baseColorTexture = { index: textures.length - 1 };
    }
    const material = { name: `${name}-material`, pbrMetallicRoughness: pbr };
    if (m.emissive) material.emissiveFactor = linear(m.emissive);
    if (m.unlit) {
      material.extensions = { KHR_materials_unlit: {} };
      extensions.add('KHR_materials_unlit');
    }
    materials.push(material);
    meshes.push({ name, primitives: [{ attributes, indices, material: i }] });
    nodes.push({ name, mesh: i });
  });
  const json = {
    asset: { version: '2.0', generator: 'voxel-vault make-sample-ruin.mjs' },
    ...(extensions.size ? { extensionsUsed: [...extensions] } : {}),
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: length }],
    ...(images.length
      ? { images, textures, samplers: [{ magFilter: 9728, minFilter: 9728 }] }
      : {}),
  };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks),
    header = Buffer.alloc(12),
    jh = Buffer.alloc(8),
    bh = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  jh.writeUInt32LE(text.length);
  jh.writeUInt32LE(0x4e4f534a, 4);
  bh.writeUInt32LE(bin.length);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, text, bh, bin]);
}

const iron = { color: '#3a3836', metallic: 0.6, roughness: 0.55 };
const MODELS = {
  // A brazier in a block's units, its foot at y 0: a bowl on three legs, embers glowing in it.
  brazier: glb([
    {
      name: 'legs',
      geometry: merge(
        [
          [-0.22, -0.22],
          [0.22, -0.22],
          [0, 0.25],
        ].map(([x, z]) => box([x, 0.2, z], [0.07, 0.4, 0.07])),
      ),
      material: iron,
    },
    {
      name: 'bowl',
      geometry: merge([
        box([0, 0.45, 0], [0.62, 0.1, 0.62]),
        box([0, 0.55, 0.28], [0.62, 0.14, 0.06]),
        box([0, 0.55, -0.28], [0.62, 0.14, 0.06]),
        box([0.28, 0.55, 0], [0.06, 0.14, 0.5]),
        box([-0.28, 0.55, 0], [0.06, 0.14, 0.5]),
      ]),
      material: iron,
    },
    {
      name: 'embers',
      geometry: merge([
        box([0, 0.54, 0], [0.46, 0.08, 0.46]),
        box([0.06, 0.6, -0.05], [0.16, 0.08, 0.14]),
      ]),
      material: { color: '#ff7a1e', roughness: 1, emissive: '#ff6a10' },
    },
  ]),
};
const CALIBRATION_MODELS = {
  // Plates of known colours: unlit by factor, unlit by texture (the same PNG as the block tile), and lit.
  'color-reference': glb([
    {
      name: 'unlit-factor',
      geometry: box([-0.75, 0.5, 0], [0.45, 0.9, 0.08]),
      material: { color: '#c86432', unlit: true },
    },
    {
      name: 'unlit-texture',
      geometry: box([0, 0.5, 0], [0.45, 0.9, 0.08]),
      material: { color: '#ffffff', unlit: true, texture: CALIBRATION_TILES.ref_orange },
    },
    {
      name: 'lit-texture',
      geometry: box([0.75, 0.5, 0], [0.45, 0.9, 0.08]),
      material: { color: '#ffffff', roughness: 1, texture: CALIBRATION_TILES.ref_orange },
    },
  ]),
};
const VARIANT_MODELS = {
  // The same name, another thing: a crystal on a plinth. Swapped in, the decor changes.
  brazier: glb([
    {
      name: 'plinth',
      geometry: box([0, 0.12, 0], [0.5, 0.24, 0.5]),
      material: { color: '#6f6861', roughness: 0.9 },
    },
    {
      name: 'crystal',
      geometry: merge([
        box([0, 0.6, 0], [0.18, 0.75, 0.18]),
        box([0.12, 0.45, 0.05], [0.1, 0.4, 0.1]),
        box([-0.1, 0.42, -0.06], [0.1, 0.32, 0.1]),
      ]),
      material: { color: '#7fe0ff', roughness: 0.2, emissive: '#2a9fd0' },
    },
  ]),
};

// ── The structures ───────────────────────────────────────────────────────────
// Block numbers are pack.json's "blocks" order + 1 (0 is air); a tool would read them from there.
const B = { turf: 1, bricks: 2, mossy: 3, floor: 4, pillar: 5, bench: 6, lamp: 7 };
function structure() {
  const [sx, sy, sz] = [12, 8, 12],
    cells = new Uint16Array(sx * sy * sz);
  const set = (x, y, z, b) => {
    cells[x + sx * (y + sy * z)] = b;
  };
  const rand = seeded(42);
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) set(x, 0, z, B.turf);
  for (let z = 2; z <= 9; z++) for (let x = 2; x <= 9; x++) set(x, 1, z, B.floor);
  // The back wall, whole; the side walls broken off lower towards the front.
  for (let x = 2; x <= 9; x++)
    for (let y = 2; y <= 5; y++) set(x, y, 2, rand() < 0.3 ? B.mossy : B.bricks);
  for (let z = 3; z <= 7; z++) {
    const top = 5 - Math.floor((z - 3) * 0.8);
    for (let y = 2; y <= top; y++) {
      set(2, y, z, rand() < 0.35 ? B.mossy : B.bricks);
      if (z < 6) set(9, y, z, rand() < 0.35 ? B.mossy : B.bricks);
    }
  }
  // The altar: a 3×3 dais the guest stands on.
  for (let z = 4; z <= 6; z++) for (let x = 4; x <= 6; x++) set(x, 2, z, B.floor);
  // Pillars at the front corners; a lamp on the right one.
  for (let y = 2; y <= 4; y++) set(2, y, 9, B.pillar);
  for (let y = 2; y <= 3; y++) set(9, y, 9, B.pillar);
  set(9, 4, 9, B.lamp);
  set(7, 2, 8, B.bench);
  set(8, 2, 8, B.bench);
  return Buffer.from(cells.buffer);
}

// The calibration bench, 9×3×5: a grey floor; on it, left to right, the compass block (x 1), the
// reference block (x 3) and the plates' place (pack.json puts the model at x 6), all on row z 2,
// with nothing in front of them towards the camera (south).
const C = { grey: 1, orange: 2, compass: 3 };
function calibration() {
  const [sx, sy, sz] = [9, 3, 5],
    cells = new Uint16Array(sx * sy * sz);
  const set = (x, y, z, b) => {
    cells[x + sx * (y + sy * z)] = b;
  };
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) set(x, 0, z, C.grey);
  set(1, 1, 2, C.compass);
  set(3, 1, 2, C.orange);
  return Buffer.from(cells.buffer);
}

const args = process.argv.slice(2);
if (args[0] === '--variants') {
  const out = args[1];
  for (const [name, data] of Object.entries(VARIANT_TILES))
    await write(join(out, 'textures', `${name}.png`), data);
  for (const [name, data] of Object.entries(VARIANT_MODELS))
    await write(join(out, 'models', `${name}.glb`), data);
} else {
  const packs = args[0] ?? 'packs';
  for (const [dir, tiles, models, cells] of [
    ['sample-ruin', TILES, MODELS, structure()],
    ['color-calibration', CALIBRATION_TILES, CALIBRATION_MODELS, calibration()],
  ]) {
    for (const [name, data] of Object.entries(tiles))
      await write(join(packs, dir, 'textures', `${name}.png`), data);
    for (const [name, data] of Object.entries(models))
      await write(join(packs, dir, 'models', `${name}.glb`), data);
    await write(join(packs, dir, 'structure.u16'), cells);
  }
}
async function write(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  console.log(path, data.length);
}
