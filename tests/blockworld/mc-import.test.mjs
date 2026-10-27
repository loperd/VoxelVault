// The Minecraft importer (tools/mc-import) on synthetic schematics written here: no real building,
// no Mojang art. Tiles are made in the test; the packs go through readWorldPack → loadPackAssets →
// packStage → BlockView as any pack does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Mesh } from 'three';
import { cropSchematic, readSchematic } from '../../tools/mc-import/schem.ts';
import { parseState } from '../../tools/mc-import/states.ts';
import { geometry, turnFaces, SIDES } from '../../tools/mc-import/geometry.ts';
import { readMapping } from '../../tools/mc-import/mapping.ts';
import { importSchematic } from '../../tools/mc-import/import.ts';
import { drawn, flatten, probeParts, quad, select } from '../../tools/mc-import/models.ts';
import { compare, ownQuads } from '../../tools/mc-import/verify.ts';
import { BlockRegistry } from '../../packages/blockworld/src/blocks.ts';
import { BlockWorld } from '../../packages/blockworld/src/world.ts';
import { computeLight } from '../../packages/blockworld/src/light.ts';
import { meshWorld } from '../../packages/blockworld/src/mesher.ts';
import { reportMarkdown } from '../../tools/mc-import/report.ts';
import { decodeImage, encodeImage, rotate } from '../../tools/mc-import/textures.ts';
import { readWorldPack } from '../../packages/blockworld/src/pack/read.ts';
import { loadPackAssets, packDiagnostics } from '../../packages/blockworld/src/pack/assets.ts';
import { packStage } from '../../packages/blockworld/src/pack/stage.ts';
import { BlockView } from '../../packages/blockworld/src/view.ts';
import { fakePage, never } from './pack-fixture.mjs';

// ── A Sponge schematic writer (big-endian NBT, gzip) ───────────────────────────────────────────
const TAG = { byte: 1, short: 2, int: 3, string: 8, list: 9, compound: 10, bytes: 7, ints: 11 };
function nbt(root) {
  const parts = [],
    u8 = (...b) => parts.push(Buffer.from(b));
  const i16 = (v) => {
      const b = Buffer.alloc(2);
      b.writeInt16BE(v);
      parts.push(b);
    },
    i32 = (v) => {
      const b = Buffer.alloc(4);
      b.writeInt32BE(v);
      parts.push(b);
    };
  const str = (s) => {
    const b = Buffer.from(s, 'utf8');
    i16(b.length);
    parts.push(b);
  };
  const payload = ([type, value]) => {
    if (type === 'byte') u8(value & 255);
    else if (type === 'short') i16(value);
    else if (type === 'int') i32(value);
    else if (type === 'string') str(value);
    else if (type === 'bytes') {
      i32(value.length);
      parts.push(Buffer.from(value));
    } else if (type === 'ints') {
      i32(value.length);
      value.forEach(i32);
    } else if (type === 'list') {
      u8(value.length ? TAG[value[0][0]] : 0);
      i32(value.length);
      value.forEach(payload);
    } else if (type === 'compound') {
      for (const [k, v] of Object.entries(value)) {
        u8(TAG[v[0]]);
        str(k);
        payload(v);
      }
      u8(0);
    }
  };
  u8(10);
  str('Schematic');
  payload(['compound', root]);
  return gzipSync(Buffer.concat(parts));
}
const varints = (values) =>
  values.flatMap((v) => {
    const out = [];
    do {
      out.push((v & 0x7f) | (v > 0x7f ? 0x80 : 0));
      v >>>= 7;
    } while (v);
    return out;
  });

/** A schematic from a cell function (x, y, z) → state string; Sponge v2, or v3 when asked; data version 3120 (1.19.2) unless given, none for null. */
function schematic(
  size,
  cell,
  { version = 2, dataVersion = 3120, blockEntities = [], entities = [] } = {},
) {
  const [w, h, l] = size,
    palette = new Map(),
    data = [];
  for (let y = 0; y < h; y++)
    for (let z = 0; z < l; z++)
      for (let x = 0; x < w; x++) {
        const s = cell(x, y, z) ?? 'minecraft:air';
        if (!palette.has(s)) palette.set(s, palette.size);
        data.push(palette.get(s));
      }
  const pal = ['compound', Object.fromEntries([...palette].map(([k, v]) => [k, ['int', v]]))];
  const be = [
    'list',
    blockEntities.map(([pos, id]) => ['compound', { Pos: ['ints', pos], Id: ['string', id] }]),
  ];
  const common = {
    Version: ['int', version],
    ...(dataVersion === null ? {} : { DataVersion: ['int', dataVersion] }),
    Width: ['short', w],
    Height: ['short', h],
    Length: ['short', l],
    Entities: ['list', entities.map((id) => ['compound', { Id: ['string', id] }])],
  };
  return nbt(
    version === 3
      ? {
          ...common,
          Blocks: ['compound', { Palette: pal, Data: ['bytes', varints(data)], BlockEntities: be }],
        }
      : {
          ...common,
          PaletteMax: ['int', palette.size],
          Palette: pal,
          BlockData: ['bytes', varints(data)],
          BlockEntities: be,
        },
  );
}

// ── Tiles of a test resource pack ─────────────────────────────────────────────────────────────────
/** A 16×16 tile whose pixel (x, y) encodes its name's colour and its position, so turns can be checked. */
const tilePng = (r, g, { size = 16, frames = 1, alpha = () => 255 } = {}) => {
  const rgba = new Uint8Array(size * size * frames * 4);
  for (let y = 0; y < size * frames; y++)
    for (let x = 0; x < size; x++)
      rgba.set([r, g, x * 16 + (y % size), alpha(x, y)], (y * size + x) * 4);
  return encodeImage({ width: size, height: size * frames, rgba });
};
const TILES = {
  stone_bricks: tilePng(120, 1),
  oak_planks: tilePng(160, 2),
  oak_log: tilePng(90, 3),
  oak_log_top: tilePng(150, 4),
  barrel_top: tilePng(100, 5),
  barrel_bottom: tilePng(100, 6),
  barrel_side: tilePng(100, 7),
  oak_leaves: tilePng(128, 8, { alpha: (x) => (x % 4 ? 255 : 0) }),
  oak_trapdoor: tilePng(140, 9, { alpha: (x, y) => (x > 4 && x < 8 && y > 4 && y < 8 ? 0 : 255) }),
  red_stained_glass: tilePng(200, 10, { alpha: () => 120 }),
  fire_0: tilePng(250, 11, { frames: 4, alpha: (x, y) => (y % 16 < 6 ? 0 : 255) }),
  lantern: tilePng(230, 12),
  oak_door_bottom: tilePng(150, 13),
  missing: tilePng(255, 0),
  big: tilePng(1, 1, { size: 32 }),
};
const resources = (tiles = TILES) => ({ name: 'test tiles', texture: (name) => tiles[name] });
const MAPPING = readMapping({
  format: 1,
  blocks: {
    stone_bricks: { textures: { all: 'stone_bricks' } },
    oak_planks: { textures: { all: 'oak_planks' } },
    oak_log: { textures: { end: 'oak_log_top', side: 'oak_log' } },
    oak_leaves: { textures: { all: 'oak_leaves' } },
    barrel: { textures: { top: 'barrel_top', bottom: 'barrel_bottom', side: 'barrel_side' } },
    oak_trapdoor: { textures: { all: 'oak_trapdoor' } },
    red_stained_glass: { textures: { all: 'red_stained_glass' } },
    fire: { textures: { all: 'fire_0' }, light: 15 },
    lantern: { textures: { all: 'lantern' }, light: 15 },
    oak_door: { textures: { all: 'oak_door_bottom' } },
    mossy_cobblestone: { textures: { all: 'mossy_cobblestone' } },
    crying_obsidian: {
      textures: { all: 'stone_bricks' },
      approximate: 'no crying_obsidian tile: stone bricks',
    },
    huge: { textures: { all: 'big' } },
  },
  materials: { stone_brick: 'stone_bricks' },
  tints: { oak_leaves: '#77ab2f' },
});

const cellsOf = (files) => {
  const b = files.get('structure.u16'),
    v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return (i) => v.getUint16(2 * i, true);
};

test('Sponge v2 and v3: the same cells, palette and block entities; varints past 127; broken files are refused', () => {
  const cell = (x, y, z) =>
    (x + y + z) % 2
      ? `minecraft:oak_log[axis=${['x', 'y', 'z'][x % 3]}]`
      : y === 1 && x === 1
        ? 'minecraft:barrel[facing=up,open=false]'
        : undefined;
  for (const version of [2, 3]) {
    const s = readSchematic(
      schematic([3, 2, 4], cell, {
        version,
        blockEntities: [[[1, 1, 0], 'minecraft:barrel']],
        entities: ['minecraft:armor_stand', 'minecraft:armor_stand'],
      }),
    );
    assert.deepEqual([s.version, s.dataVersion, s.size], [version, 3120, [3, 2, 4]]);
    for (let y = 0; y < 2; y++)
      for (let z = 0; z < 4; z++)
        for (let x = 0; x < 3; x++)
          assert.equal(s.palette[s.blocks[x + 3 * (z + 4 * y)]], cell(x, y, z) ?? 'minecraft:air');
    assert.deepEqual([...s.blockEntities], [[1 + 3 * (0 + 4 * 1), 'barrel']]);
    assert.deepEqual([...s.entities], [['armor_stand', 2]]);
  }
  // 200 states: indices past 127 take two bytes.
  const many = readSchematic(schematic([200, 1, 1], (x) => `minecraft:block_${x}`));
  assert.equal(many.palette[many.blocks[150]], 'minecraft:block_150');
  const bytes = schematic([2, 1, 1], () => 'minecraft:stone');
  assert.throws(() => readSchematic(bytes.subarray(0, bytes.length - 8)));
  assert.throws(
    () =>
      readSchematic(
        nbt({
          Version: ['int', 9],
          Width: ['short', 1],
          Height: ['short', 1],
          Length: ['short', 1],
        }),
      ),
    /version 9/,
  );
  assert.throws(
    () =>
      readSchematic(
        nbt({
          Version: ['int', 2],
          Width: ['short', 2],
          Height: ['short', 1],
          Length: ['short', 1],
          Palette: ['compound', { 'minecraft:stone': ['int', 0] }],
          BlockData: ['bytes', [0, 5]],
        }),
      ),
    /past the palette/,
  );
  // A region: the cells and block entities inside it, nothing else.
  const crop = cropSchematic(
    readSchematic(schematic([3, 2, 4], cell, { blockEntities: [[[1, 1, 0], 'minecraft:barrel']] })),
    [1, 1, 0],
    [2, 1, 1],
  );
  assert.deepEqual(crop.size, [2, 1, 2]);
  assert.equal(crop.palette[crop.blocks[0]], cell(1, 1, 0));
  assert.deepEqual([...crop.blockEntities], [[0, 'barrel']]);
});

test('states: namespace and property order normalised, every property kept, malformed states refused', () => {
  const a = parseState(
      'minecraft:oak_stairs[half=top,facing=east,waterlogged=false,shape=straight]',
    ),
    b = parseState('oak_stairs[waterlogged=false,shape=straight,facing=east,half=top]');
  assert.equal(a.key, 'oak_stairs[facing=east,half=top,shape=straight,waterlogged=false]');
  assert.equal(a.key, b.key);
  assert.deepEqual(Object.keys(a.props), ['facing', 'half', 'shape', 'waterlogged']);
  assert.equal(parseState('create:shaft[axis=y]').key, 'create:shaft[axis=y]');
  for (const bad of [
    'oak_stairs[facing]',
    'oak_stairs[a=1,a=2]',
    'Oak Stairs',
    'oak_stairs[facing=east',
  ])
    assert.throws(() => parseState(bad), /Not a block state/);
});

test("geometry: stairs, slabs, walls, fences, trapdoors as the game's boxes; pillars and facing cubes turned with their tiles", () => {
  const g = (s) => geometry(parseState(s));
  const boxes = (s) => g(s).shape.parts.map((p) => [...p.from, ...p.to]);
  assert.deepEqual(boxes('oak_stairs[facing=east,half=bottom,shape=straight]'), [
    [0, 0, 0, 16, 8, 16],
    [8, 8, 0, 16, 16, 16],
  ]);
  assert.deepEqual(boxes('oak_stairs[facing=east,half=top,shape=straight]'), [
    [0, 8, 0, 16, 16, 16],
    [8, 0, 0, 16, 8, 16],
  ]);
  assert.equal(boxes('oak_stairs[facing=north,half=bottom,shape=inner_left]').length, 3);
  assert.deepEqual(boxes('oak_slab[type=top]'), [[0, 8, 0, 16, 16, 16]]);
  assert.equal(g('oak_slab[type=double]').shape.kind, 'cube');
  assert.deepEqual(boxes('cobblestone_wall[east=tall,north=low,south=none,up=false,west=none]'), [
    [5, 0, 0, 11, 14, 8],
    [8, 0, 5, 16, 16, 11],
  ]);
  assert.deepEqual(boxes('oak_fence[east=false,north=true,south=false,west=false]'), [
    [6, 0, 6, 10, 16, 10],
    [7, 6, 0, 9, 9, 9],
    [7, 12, 0, 9, 15, 9],
  ]);
  assert.deepEqual(boxes('oak_trapdoor[facing=north,half=bottom,open=true]'), [
    [0, 0, 13, 16, 16, 16],
  ]);
  assert.deepEqual(boxes('oak_trapdoor[facing=east,half=bottom,open=true]'), [
    [0, 0, 0, 3, 16, 16],
  ]);
  assert.deepEqual(boxes('oak_trapdoor[facing=west,half=top,open=false]'), [
    [0, 13, 0, 16, 16, 16],
  ]);
  // A closed trapdoor's tile turns with its facing; an open upper one is the plate turned over.
  assert.equal(
    g('oak_trapdoor[facing=east,half=bottom,open=false]').shape.parts[0].faces.up.quarters,
    1,
  );
  assert.equal(
    g('oak_trapdoor[facing=south,half=top,open=true]').shape.parts[0].faces.south.quarters,
    2,
  );

  // Pillars: the ends where the axis points, the side tile turned a quarter on faces it lies across.
  const roles = (s, side) => g(s).shape.faces[side];
  assert.ok(
    roles('oak_log[axis=x]', 'east').roles.includes('end') &&
      roles('oak_log[axis=x]', 'west').roles.includes('end'),
  );
  assert.ok(
    roles('oak_log[axis=z]', 'north').roles.includes('end') &&
      roles('oak_log[axis=z]', 'south').roles.includes('end'),
  );
  assert.ok(
    roles('oak_log[axis=y]', 'up').roles.includes('end') &&
      roles('oak_log[axis=y]', 'up').quarters === 0,
  );
  assert.equal(roles('oak_log[axis=x]', 'up').quarters % 2, 1, 'bark lies across x: turned on top');
  assert.equal(roles('oak_log[axis=z]', 'up').quarters % 2, 0, 'bark along z: not turned on top');
  assert.equal(
    roles('oak_log[axis=z]', 'east').quarters % 2,
    1,
    'bark along z: turned on the east side',
  );
  // Barrels: the top where facing points.
  for (const [facing, side] of [
    ['up', 'up'],
    ['down', 'down'],
    ['north', 'north'],
    ['south', 'south'],
    ['east', 'east'],
    ['west', 'west'],
  ]) {
    assert.ok(
      roles(`barrel[facing=${facing},open=false]`, side).roles.includes('top'),
      `barrel facing ${facing}: top on ${side}`,
    );
  }
  // Every turn is a proper rotation: six sides in, six sides out, each once.
  for (const [x, y] of [
    [90, 0],
    [90, 90],
    [180, 270],
    [270, 180],
  ])
    assert.equal(
      new Set(
        Object.keys(
          turnFaces(Object.fromEntries(SIDES.map((s) => [s, { roles: [s], quarters: 0 }])), x, y),
        ),
      ).size,
      6,
    );
  // Shapes blockworld cannot draw are unsupported, whatever the mapping says.
  assert.equal(
    g('oak_door[facing=north,half=lower,hinge=left,open=false,powered=false]').findings[0].code,
    'geometry',
  );
  // Properties the shape is not made from are handed on: whether they show is the blockstate's question (import.ts).
  assert.deepEqual(g('oak_leaves[distance=3,persistent=true,waterlogged=false]').unread, [
    'distance',
    'persistent',
    'waterlogged',
  ]);
  assert.deepEqual(g('grass_block[snowy=true]').unread, ['snowy']);
  assert.deepEqual(g('oak_stairs[facing=east,half=top,shape=straight,waterlogged=false]').unread, [
    'waterlogged',
  ]);
});

test('import: a pack the loader takes, a report of every state, nothing replaced by stone', async () => {
  const layout = {
    '0,0,0': 'minecraft:stone_bricks',
    '1,0,0':
      'minecraft:stone_brick_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]',
    '2,0,0': 'minecraft:oak_log[axis=x]',
    '3,0,0': 'minecraft:oak_leaves[distance=1,persistent=true,waterlogged=false]',
    '0,0,1': 'minecraft:barrel[facing=up,open=false]',
    '1,0,1':
      'minecraft:oak_trapdoor[facing=north,half=bottom,open=false,powered=false,waterlogged=false]',
    '2,0,1': 'minecraft:red_stained_glass',
    '3,0,1': 'minecraft:lantern[hanging=false,waterlogged=false]',
    '0,1,0': 'minecraft:fire[age=3,east=false,north=false,south=false,up=false,west=true]',
    '0,0,2': 'minecraft:oak_door[facing=north,half=lower,hinge=left,open=false,powered=false]',
    '1,0,2': 'minecraft:mystery_block',
    '2,0,2': 'minecraft:mossy_cobblestone',
    '3,0,2': 'minecraft:crying_obsidian',
    '0,0,3': 'minecraft:stone_bricks[waterlogged=true]',
    '1,0,3': 'stone_bricks',
    '2,0,3': 'minecraft:huge',
  };
  const schem = readSchematic(
    schematic([4, 3, 4], (x, y, z) => layout[`${x},${y},${z}`], {
      blockEntities: [[[0, 0, 1], 'minecraft:barrel']],
    }),
  );
  const { files, pack, report } = importSchematic(schem, MAPPING, resources(), {
    id: 'test-import',
    credits: { authors: ['test'], license: 'CC0-1.0' },
  });
  const state = (s) => report.states.find((r) => r.state === parseState(s).key);
  const codes = (s) =>
    state(s)
      .findings.map((f) => f.code)
      .sort();

  // Two spellings of one state are one state.
  assert.equal(state('stone_bricks').cells, 2);
  assert.deepEqual(state('stone_bricks').sources.sort(), [
    'minecraft:stone_bricks',
    'stone_bricks',
  ]);
  // Nothing to compare with (no blockstates, no models): drawn, without a loss found, and not shown exact.
  assert.equal(state('stone_bricks').result, 'unverified');
  assert.deepEqual(state('stone_bricks').fidelity, {
    geometry: 'unverified',
    material: 'unverified',
    texture: 'unverified',
    state: 'unverified',
  });
  assert.equal(
    state('minecraft:stone_brick_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]')
      .block,
    'stone_brick_stairs',
    "stairs by the game's naming",
  );
  assert.equal(state('oak_log[axis=x]').result, 'unverified');
  assert.equal(report.totals.exact.states, 0);
  assert.deepEqual(codes('oak_leaves[distance=1,persistent=true,waterlogged=false]'), [
    'biome-tint',
  ]);
  assert.deepEqual(codes('barrel[facing=up,open=false]'), ['block-entity']);
  assert.deepEqual(codes('red_stained_glass'), ['translucency']);
  assert.deepEqual(codes('lantern[hanging=false,waterlogged=false]'), ['lantern-handle']);
  assert.deepEqual(codes('fire[age=3,east=false,north=false,south=false,up=false,west=true]'), [
    'animation',
    'fire-planes',
    'fire-sides',
  ]);
  assert.deepEqual(codes('crying_obsidian'), ['stand-in']);
  assert.deepEqual(codes('stone_bricks[waterlogged=true]'), ['waterlogged']);
  // Unsupported: not drawn, with the reason, and never stone.
  assert.deepEqual(codes('oak_door[facing=north,half=lower,hinge=left,open=false,powered=false]'), [
    'geometry',
  ]);
  assert.deepEqual(codes('mystery_block'), ['no-mapping']);
  assert.deepEqual(codes('mossy_cobblestone'), ['texture-missing']);
  assert.deepEqual(codes('huge'), ['texture-size']);
  const cell = cellsOf(files),
    at = (x, y, z) => cell(x + 4 * (y + 3 * z));
  for (const [x, y, z] of [
    [0, 0, 2],
    [1, 0, 2],
    [2, 0, 2],
    [2, 0, 3],
  ])
    assert.equal(at(x, y, z), 0, `unsupported cell ${x},${y},${z} left empty`);
  assert.ok(!JSON.stringify(pack.blocks).includes('"stone"'));
  // Totals add up: every non-air cell is in exactly one result.
  const sum = (k) => report.states.filter((s) => s.result === k).reduce((n, s) => n + s.cells, 0);
  const results = ['exact', 'unverified', 'approximated', 'unsupported'];
  assert.deepEqual(
    results.map((k) => report.totals[k].cells),
    results.map(sum),
  );
  assert.equal(
    results.reduce((n, k) => n + report.totals[k].cells, 0),
    report.cells.blocks,
  );
  for (const aspect of ['geometry', 'material', 'texture', 'state'])
    assert.equal(
      results.reduce((n, k) => n + report.aspects[aspect][k].cells, 0),
      report.cells.blocks,
      aspect,
    );
  assert.equal(report.cells.blocks, 16);
  assert.deepEqual(report.blockEntities, { barrel: 1 });
  assert.match(reportMarkdown(report, 'test'), /\| unsupported \| 4 \|/);

  // Turns are baked into tiles: the log lying along x shows its bark turned on top.
  const log = pack.blocks.find((b) => b.name === 'oak_log');
  // The ends where the axis points (turned as the game turns the model: no uvlock for logs).
  assert.ok([log.textures.east, log.textures.west].every((t) => /^oak_log_top(-r\d)?$/.test(t)));
  assert.match(log.textures.up, /^oak_log-r[13]$/);
  const turned = decodeImage(files.get(pack.textures[log.textures.up])),
    q = Number(log.textures.up.at(-1));
  assert.deepEqual(turned.rgba, rotate(decodeImage(TILES.oak_log), q).rgba);
  // Cut-outs: leaves and the trapdoor's holes stay clear; glass is drawn solid.
  assert.equal(pack.blocks.find((b) => b.name === 'oak_leaves').cutout, true);
  assert.equal(pack.blocks.find((b) => b.name === 'oak_trapdoor').cutout, true);
  assert.equal(pack.blocks.find((b) => b.name === 'red_stained_glass').cutout, undefined);
  assert.ok(
    decodeImage(files.get(pack.textures.red_stained_glass)).rgba.every(
      (v, i) => i % 4 !== 3 || v === 255,
    ),
  );
  assert.deepEqual(pack.blocks.find((b) => b.name === 'lantern').parts[0].faces.north, {
    uv: [0, 2, 6, 9],
  });

  // The pack as the game reads it, and drawn: the same path as any pack, its own atlas.
  const read = await readWorldPack(async (path) => files.get(path).slice().buffer, {
    signal: never,
  });
  assert.equal(read.blocks.length, pack.blocks.length);
  const page = fakePage();
  try {
    const assets = await loadPackAssets(read, { signal: never });
    const view = new BlockView(page.element(), packStage(assets, { camera: 'overview' }));
    view.renderAt(0);
    const meshes = [];
    view.stage.root.traverse((o) => {
      if (o instanceof Mesh) meshes.push(o);
    });
    assert.ok(
      meshes.length > 0 &&
        meshes.every((m) => m.material.map === assets.atlas.texture || !m.material.map),
    );
    view.dispose();
    assets.release();
    assert.deepEqual(
      { assets: packDiagnostics.assets, resources: packDiagnostics.resources },
      { assets: 0, resources: 0 },
    );
  } finally {
    page.restore();
  }
});

test('import: a placeholder only where the mapping names one, and reported as such', () => {
  const schem = readSchematic(
    schematic([2, 1, 1], (x) => (x ? 'minecraft:mystery_block' : 'minecraft:stone_bricks')),
  );
  const withPlaceholder = readMapping({
    ...JSON.parse(
      JSON.stringify({
        format: 1,
        blocks: MAPPING.blocks,
        materials: MAPPING.materials,
        tints: MAPPING.tints,
      }),
    ),
    placeholder: 'missing',
  });
  const { files, pack, report } = importSchematic(schem, withPlaceholder, resources(), {
    id: 'placeholder',
  });
  const mystery = report.states.find((s) => s.state === 'mystery_block');
  assert.deepEqual([mystery.result, mystery.block], ['unsupported', 'placeholder']);
  assert.equal(pack.blocks[cellsOf(files)(1) - 1].name, 'placeholder');
  assert.deepEqual(pack.blocks.find((b) => b.name === 'placeholder').textures, { all: 'missing' });
});

test('mapping: every problem named; a material must name a block of the mapping', () => {
  assert.throws(
    () =>
      readMapping({
        format: 2,
        blocks: { a: { textures: { sideways: 'x', all: 'Bad Name' }, light: 20, extra: 1 } },
        materials: { b: 'nowhere' },
        tints: { a: 'green' },
      }),
    (error) =>
      [
        'mapping.format',
        'textures.sideways: not a role',
        'textures.all: not a tile name',
        'light: 0..15',
        'extra: unknown key',
        'materials.b',
        'tints.a',
      ].every((s) => error.message.includes(s)),
  );
});

// ── Sponge files written by another NBT library ───────────────────────────────────────────────────
const FIXTURES = new URL('./fixtures/sponge/', import.meta.url);
const fixture = (name) => new Uint8Array(readFileSync(new URL(name, FIXTURES)));

test('Sponge v1, v2, v3 written by prismarine-nbt (scripts/packs/make-schem-fixtures.mjs): every cell, the palette, block entities, strays, entities', () => {
  const expected = JSON.parse(readFileSync(new URL('expected.json', FIXTURES), 'utf8'));
  for (const version of [1, 2, 3]) {
    const s = readSchematic(fixture(`v${version}.schem`)),
      v = `v${version}`;
    assert.equal(s.version, version);
    assert.equal(s.dataVersion ?? null, expected.dataVersion[v]);
    assert.deepEqual(s.size, expected.size);
    // The palette by the file's own indices, which are not the order the states were written in.
    for (const [state, index] of Object.entries(expected.palette))
      assert.equal(s.palette[index], state, `${v} palette ${index}`);
    assert.deepEqual([...s.blocks], expected.cells, `${v} cells`);
    const [[pos, id]] = expected.blockEntities.inside,
      [x, y, z] = pos;
    assert.deepEqual(
      [...s.blockEntities],
      [[x + s.size[0] * (z + s.size[2] * y), id]],
      `${v} block entities`,
    );
    assert.equal(
      s.strayBlockEntities,
      expected.blockEntities.outside,
      `${v}: the chest outside the schematic is counted`,
    );
    assert.deepEqual(Object.fromEntries(s.entities), expected.entities[v], `${v} entities`);
    // The state prismarine-schematic 1.3.0 turns into birch_leaves[distance=1] (its int properties are off by one).
    assert.ok(
      s.palette.includes('minecraft:spruce_leaves[distance=7,persistent=true,waterlogged=false]'),
    );
  }
});

test('Sponge reader: broken and extreme files are refused with a reason, never a crash or a silent loss', () => {
  const v2 = (extra = {}, data = [0]) =>
    nbt({
      Version: ['int', 2],
      Width: ['short', 1],
      Height: ['short', 1],
      Length: ['short', 1],
      Palette: ['compound', { 'minecraft:stone': ['int', 0] }],
      BlockData: ['bytes', data],
      ...extra,
    });
  assert.equal(readSchematic(v2()).palette[readSchematic(v2()).blocks[0]], 'minecraft:stone');
  const file = fixture('v2.schem');
  assert.throws(
    () => readSchematic(file.subarray(0, file.length - 20)),
    /unexpected end|incorrect header|ends|Z_BUF_ERROR/i,
    'a cut gzip',
  );
  assert.throws(() => readSchematic(Buffer.from([8, 0, 0])), /root is not a compound/);
  assert.throws(() => readSchematic(Buffer.from([10, 0, 0, 99, 0, 1, 97])), /unknown tag type 99/);
  assert.throws(
    () => readSchematic(Buffer.from([10, 0, 0, 7, 0, 1, 97, 0xff, 0xff, 0xff, 0xff])),
    /bad length/,
    'a negative array length',
  );
  // A compound nested 100 deep: refused, not a stack overflow.
  assert.throws(
    () => readSchematic(Buffer.from([10, 0, 0, ...Array(100).fill([10, 0, 1, 97]).flat()])),
    /nested too deep/,
  );
  assert.throws(() => readSchematic(v2({}, [0, 0])), /longer than the schematic/);
  assert.throws(() => readSchematic(v2({ Width: ['short', 2] }, [0])), /block data for at most 1/);
  assert.throws(() => readSchematic(v2({}, [0x80, 0x80, 0x80, 0x80, 0x01])), /varint too long/);
  assert.throws(() => readSchematic(v2({}, [1])), /past the palette/);
  // Sizes are unsigned shorts: 65535 × 65535 × 65535 cells for one byte of data is refused before anything is allocated.
  assert.throws(
    () => readSchematic(v2({ Width: ['short', -1], Height: ['short', -1], Length: ['short', -1] })),
    /65535×65535×65535 cells, but block data for at most 1/,
  );
  // An empty schematic is a schematic.
  assert.equal(readSchematic(v2({ Width: ['short', 0] }, [])).blocks.length, 0);
  // Palette indices: unique; gaps allowed (the spec does not forbid them), a cell naming a gap refused.
  assert.throws(
    () =>
      readSchematic(
        v2({
          Palette: ['compound', { 'minecraft:stone': ['int', 0], 'minecraft:dirt': ['int', 0] }],
        }),
      ),
    /bad palette index 0/,
  );
  assert.throws(
    () => readSchematic(v2({ Palette: ['compound', { 'minecraft:stone': ['int', -1] }] })),
    /bad palette index -1/,
  );
  const gap = v2(
    {
      Width: ['short', 2],
      Palette: ['compound', { 'minecraft:stone': ['int', 0], 'minecraft:dirt': ['int', 2] }],
    },
    [2, 0],
  );
  assert.deepEqual([...readSchematic(gap).blocks], [2, 0]);
  assert.throws(
    () =>
      readSchematic(
        v2(
          {
            Width: ['short', 2],
            Palette: ['compound', { 'minecraft:stone': ['int', 0], 'minecraft:dirt': ['int', 2] }],
          },
          [1, 0],
        ),
      ),
    /palette index 1 names no state/,
  );
  // A three-byte varint: palette index 16384.
  const wide = Object.fromEntries(
    Array.from({ length: 16385 }, (_, i) => [`minecraft:b${i}`, ['int', i]]),
  );
  assert.equal(
    readSchematic(v2({ Palette: ['compound', wide] }, [0x80, 0x80, 0x01])).palette[
      readSchematic(v2({ Palette: ['compound', wide] }, [0x80, 0x80, 0x01])).blocks[0]
    ],
    'minecraft:b16384',
  );
  // Version 3 needs its Blocks; versions outside 1–3 are refused.
  assert.throws(
    () =>
      readSchematic(
        nbt({
          Schematic: [
            'compound',
            {
              Version: ['int', 3],
              Width: ['short', 1],
              Height: ['short', 1],
              Length: ['short', 1],
            },
          ],
        }),
      ),
    /no Blocks/,
  );
  assert.throws(() => readSchematic(v2({ Version: ['int', 0] })), /version 0/);
  // Block entities without a position or outside the schematic are counted.
  const strays = readSchematic(
    v2({
      BlockEntities: [
        'list',
        [
          ['compound', { Id: ['string', 'minecraft:sign'] }],
          ['compound', { Id: ['string', 'minecraft:chest'], Pos: ['ints', [0, 5, 0]] }],
        ],
      ],
    }),
  );
  assert.deepEqual([strays.blockEntities.size, strays.strayBlockEntities], [0, 2]);
});

// ── The game's blockstates and models as an oracle (hand-written here, shaped as the game's) ─────
const ASSETS = {
  name: 'test models',
  states: {
    oak_stairs: {
      variants: {
        'facing=east,half=bottom,shape=straight': { model: 'block/oak_stairs' },
        'facing=north,half=bottom,shape=straight': {
          model: 'block/oak_stairs',
          y: 270,
          uvlock: true,
        },
      },
    },
    fence: {
      multipart: [
        { apply: { model: 'block/fence_post' } },
        { when: { north: 'true' }, apply: { model: 'block/fence_side', uvlock: true } },
        {
          when: { OR: [{ east: 'true' }, { west: 'low|tall' }] },
          apply: { model: 'block/fence_side', y: 90, uvlock: true },
        },
      ],
    },
    lamp: {
      variants: {
        'lit=false': [{ model: 'block/lamp' }, { model: 'block/lamp', y: 90 }],
        'lit=true': { model: 'block/lamp' },
      },
    },
    leaves: { variants: { '': { model: 'block/leaves' } } },
    door: { variants: { 'facing=east,half=lower': { model: 'block/door_bottom' } } },
  },
  models: {
    'block/cube': {
      elements: [
        {
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: Object.fromEntries(
            ['north', 'south', 'east', 'west', 'up', 'down'].map((s) => [s, { texture: `#${s}` }]),
          ),
        },
      ],
    },
    'block/cube_all': {
      parent: 'block/cube',
      textures: Object.fromEntries(
        ['north', 'south', 'east', 'west', 'up', 'down'].map((s) => [s, '#all']),
      ),
    },
    'block/leaves': { parent: 'block/cube_all', textures: { all: 'minecraft:block/oak_leaves' } },
    'block/lamp': { parent: 'block/cube_all', textures: { all: 'block/lamp' } },
    // Stairs as the game cuts them: a slab and a half-height step.
    'block/oak_stairs': {
      textures: { side: 'block/oak_planks' },
      elements: [
        {
          from: [0, 0, 0],
          to: [16, 8, 16],
          faces: Object.fromEntries(
            ['north', 'south', 'east', 'west', 'up', 'down'].map((s) => [s, { texture: '#side' }]),
          ),
        },
        {
          from: [8, 8, 0],
          to: [16, 16, 16],
          faces: Object.fromEntries(
            ['north', 'south', 'east', 'west', 'up'].map((s) => [s, { texture: '#side' }]),
          ),
        },
      ],
    },
    'block/fence_post': {
      elements: [
        {
          from: [6, 0, 6],
          to: [10, 16, 10],
          faces: Object.fromEntries(
            ['north', 'south', 'east', 'west', 'up', 'down'].map((s) => [
              s,
              { texture: 'block/oak_planks' },
            ]),
          ),
        },
      ],
    },
    'block/fence_side': {
      elements: [
        {
          from: [7, 12, 0],
          to: [9, 15, 9],
          faces: {
            north: { texture: 'block/oak_planks' },
            east: { texture: 'block/oak_planks' },
            west: { texture: 'block/oak_planks' },
            up: { texture: 'block/oak_planks' },
            down: { texture: 'block/oak_planks' },
          },
        },
      ],
    },
    // A door's lower half, numbers as the game's door_bottom_left: a down face turned 90° on a flipped UV.
    'block/door_bottom': {
      textures: { bottom: 'block/oak_door_bottom' },
      elements: [
        {
          from: [0, 0, 0],
          to: [3, 16, 16],
          faces: {
            down: { uv: [16, 13, 0, 16], texture: '#bottom', rotation: 90 },
            north: { uv: [3, 0, 0, 16], texture: '#bottom' },
            south: { uv: [0, 0, 3, 16], texture: '#bottom' },
            west: { uv: [0, 0, 16, 16], texture: '#bottom' },
            east: { uv: [16, 0, 0, 16], texture: '#bottom' },
          },
        },
      ],
    },
  },
};
// As an extracted 1.19.2 jar: its version, and its own tiles (here the test's).
const assets = {
  name: ASSETS.name,
  version: { id: '1.19.2', dataVersion: 3120 },
  blockstate: (n) => ASSETS.states[n],
  model: (p) => ASSETS.models[p],
  texture: (n) => TILES[n],
};

test('models: variants and multipart pick the models and name the properties the blockstate reads; parents and #variables resolve', () => {
  const pick = (s) => select(parseState(s), assets);
  assert.deepEqual(
    pick('oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]').placed,
    [{ model: 'block/oak_stairs', x: 0, y: 270, uvlock: true, choices: 1 }],
  );
  assert.deepEqual(
    [...pick('oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]').props].sort(),
    ['facing', 'half', 'shape'],
    'waterlogged is not read',
  );
  assert.deepEqual(
    pick('fence[east=false,north=true,south=false,west=low]').placed.map((p) => p.y),
    [0, 0, 90],
    'OR and a|b',
  );
  assert.deepEqual([...pick('fence[east=false,north=false,south=false,west=none]').props].sort(), [
    'east',
    'north',
    'west',
  ]);
  assert.equal(pick('lamp[lit=false]').placed[0].choices, 2, 'a random pick is counted');
  assert.equal(pick('unknown_block'), undefined);
  assert.deepEqual(flatten('minecraft:block/leaves', assets).elements[0].faces.up, {
    texture: 'oak_leaves',
    rotation: 0,
  });
});

test("models: the quads the oracle reckons are the ones blockworld's mesher draws (positional and own UV)", () => {
  // One boxes block with a positional face and a face of its own UV, meshed as any pack block is.
  const part = { from: [2, 3, 4], to: [10, 12, 14], faces: { east: { uv: [1, 2, 7, 15] } } };
  const blocks = new BlockRegistry(
    [{ name: 'probe', model: 'boxes', textures: { all: 't' }, boxes: [part] }],
    { strict: true },
  );
  const world = new BlockWorld(3, 3, 3);
  world.set(1, 1, 1, 1);
  computeLight(world, blocks);
  const arrays = meshWorld(world, blocks, { uv: () => [0, 0, 1, 1], occlusion: 0 }).opaque;
  const meshed = [];
  for (let q = 0; q < arrays.positions.length / 12; q++) {
    const pairs = [0, 1, 2, 3].map((i) => {
      const at = q * 4 + i;
      return `${[0, 1, 2].map((k) => +((arrays.positions[at * 3 + k] - 1) * 16).toFixed(3)).join(',')}>${+(arrays.uvs[at * 2] * 16).toFixed(3)},${+((1 - arrays.uvs[at * 2 + 1]) * 16).toFixed(3)}`;
    });
    meshed.push(pairs.sort().join(' '));
  }
  const reckoned = ['north', 'south', 'east', 'west', 'up', 'down'].map((side) => {
    const q = quad(side, part.from, part.to, 't', part.faces[side]?.uv);
    return q.points
      .map((p, i) => `${p.join(',')}>${q.uvs[i].join(',')}`)
      .sort()
      .join(' ');
  });
  assert.deepEqual(meshed.sort(), reckoned.sort());
});

test('verify: the same solid cut another way is equal; a missing face, other pixels, a lost tint and an overlay are named', () => {
  const game = (state) => drawn(select(parseState(state), assets), assets);
  const source = (t) => ({
    name: t.replace(/-r\d$/, ''),
    quarters: Number(t.match(/-r(\d)$/)?.[1] ?? 0),
  });
  const own = (definition) => ownQuads({ definition, source });
  // The importer's stairs are three boxes where the game's are two: the same solid, the same visible faces.
  const stairs = {
    name: 's',
    model: 'parts',
    textures: { all: 'oak_planks' },
    parts: [
      { from: [0, 0, 0], to: [16, 8, 16] },
      { from: [8, 8, 0], to: [16, 16, 8] },
      { from: [8, 8, 8], to: [16, 16, 16] },
    ],
  };
  const v = compare(own(stairs), game('oak_stairs[facing=east,half=bottom,shape=straight]'));
  assert.deepEqual([v.shape, v.material], [[], []]);
  // uvlock: turned stairs keep the tile still, as positional UV does.
  const north = {
    ...stairs,
    parts: [
      { from: [0, 0, 0], to: [16, 8, 16] },
      { from: [0, 8, 0], to: [16, 16, 8] },
    ],
  };
  assert.deepEqual(
    compare(own(north), game('oak_stairs[facing=north,half=bottom,shape=straight]')).shape,
    [],
  );
  // A step on the wrong side: the solid differs.
  assert.deepEqual(
    compare(
      own({
        ...stairs,
        parts: [
          { from: [0, 0, 0], to: [16, 8, 16] },
          { from: [0, 8, 0], to: [8, 16, 16] },
        ],
      }),
      game('oak_stairs[facing=east,half=bottom,shape=straight]'),
    ).shape.map((f) => f.code),
    ['model-volume', 'surface-missing', 'surface-extra'],
  );
  // The tile turned a quarter: the right tile, other pixels.
  const lamp = { name: 'l', textures: { all: 'lamp', up: 'lamp-r1' } };
  assert.deepEqual(
    compare(own(lamp), game('lamp[lit=true]')).material.map((f) => f.code),
    ['model-uv'],
  );
  assert.deepEqual(
    compare(own(lamp), game('lamp[lit=false]')).material.map((f) => f.code),
    ['model-uv', 'random-variant'],
  );
  // Tints: leaves the game tints (tintindex) drawn untinted, then tinted.
  ASSETS.models['block/tinted'] = {
    parent: 'block/cube',
    textures: Object.fromEntries(
      ['north', 'south', 'east', 'west', 'up', 'down'].map((s) => [s, 'block/oak_leaves']),
    ),
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: Object.fromEntries(
          ['north', 'south', 'east', 'west', 'up', 'down'].map((s) => [
            s,
            { texture: 'block/oak_leaves', tintindex: 0 },
          ]),
        ),
      },
    ],
  };
  ASSETS.states.tinted = { variants: { '': { model: 'block/tinted' } } };
  assert.deepEqual(
    compare(own({ name: 't', textures: { all: 'oak_leaves' } }), game('tinted')).material.map(
      (f) => f.code,
    ),
    ['tint-missing'],
  );
  assert.deepEqual(
    compare(
      ownQuads({
        definition: { name: 't', textures: { all: 'oak_leaves' } },
        source: (t) => ({ name: t, quarters: 0, tint: '#619961' }),
      }),
      game('tinted'),
    ).material,
    [],
  );
  // A second, overlaid tile on the same face (grass sides): one drawn.
  ASSETS.models['block/layered'] = {
    elements: [0, 1].map((i) => ({
      from: [0, 0, 0],
      to: [16, 16, 16],
      faces: { north: { texture: i ? 'block/overlay' : 'block/base' } },
    })),
  };
  ASSETS.states.layered = { variants: { '': { model: 'block/layered' } } };
  assert.ok(
    compare(own({ name: 'o', textures: { all: 'base' } }), game('layered')).material.some(
      (f) => f.code === 'overlay',
    ),
  );
});

test("probe: a door's model becomes parts the pack reads, the same as the model but for the face it leaves out", async () => {
  const game = drawn(
    select(parseState('door[facing=east,half=lower,hinge=left,open=false]'), assets),
    assets,
  );
  const probe = probeParts(game.quads);
  assert.deepEqual(probe.problems, [
    '0,0,0,3,16,16: the model leaves out up; a part draws all six (seen or not: verify.ts)',
  ]);
  // The down face's 90° turn becomes a turned tile copy and a UV on it.
  const [part] = probe.parts,
    faces = Object.fromEntries(
      Object.entries(part.faces).map(([side, f]) => [
        side,
        { texture: f.quarters ? `${f.tile}-r${f.quarters}` : f.tile, uv: f.uv },
      ]),
    );
  assert.equal(part.faces.down.quarters % 2, 1);
  const definition = {
    name: 'door_lower',
    model: 'parts',
    textures: { all: 'oak_door_bottom' },
    cutout: true,
    parts: [{ from: part.from, to: part.to, faces }],
  };
  const v = compare(
    ownQuads({
      definition,
      source: (t) => ({
        name: t.replace(/-r\d$/, ''),
        quarters: Number(t.match(/-r(\d)$/)?.[1] ?? 0),
      }),
    }),
    game,
  );
  assert.deepEqual(v.material, []);
  assert.deepEqual(
    v.shape.map((f) => f.code),
    ['surface-extra'],
    'the top a part cannot leave out (the upper half covers it in a world)',
  );
  // The pack takes it as it is: no change to blockworld.
  const tile = encodeImage({ width: 16, height: 16, rgba: new Uint8Array(16 * 16 * 4).fill(200) });
  const files = new Map([
    ['textures/d.png', tile],
    ['textures/d1.png', tile],
    ['structure.u16', new Uint8Array([1, 0])],
    [
      'pack.json',
      new TextEncoder().encode(
        JSON.stringify({
          format: 1,
          id: 'door-probe',
          version: '1',
          requires: { blockworld: 1 },
          textures: { oak_door_bottom: 'textures/d.png', 'oak_door_bottom-r1': 'textures/d1.png' },
          blocks: [definition],
          structure: { size: [1, 1, 1], cells: 'structure.u16' },
          markers: { m: { at: [0.5, 1, 0.5] } },
          cameras: { c: { eye: [3, 2, 3], look: 'm' } },
          environment: {
            sky: { top: '#000000', horizon: '#000000', bottom: '#000000' },
            fog: { color: '#000000', near: 1, far: 2 },
            light: { sky: '#000000', ground: '#000000', key: '#ffffff' },
          },
        }),
      ),
    ],
  ]);
  const read = await readWorldPack(async (path) => files.get(path).slice().buffer, {
    signal: never,
  });
  assert.equal(read.blocks[0].boxes[0].faces.down.texture, 'oak_door_bottom-r1');
});

test("import with the game's blockstates and models: exact only where the comparison shows it; tints by block; unread properties by blockstate", () => {
  ASSETS.models['block/tinted'] = {
    parent: 'block/cube',
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: Object.fromEntries(
          ['north', 'south', 'east', 'west', 'up', 'down'].map((s) => [
            s,
            { texture: 'block/oak_leaves', tintindex: 0 },
          ]),
        ),
      },
    ],
  };
  ASSETS.states.spruce_leaves = { variants: { '': { model: 'block/spruce_leaves' } } };
  ASSETS.models['block/spruce_leaves'] = { parent: 'block/tinted', textures: {} };
  ASSETS.states.oak_leaves = { variants: { '': { model: 'block/tinted' } } };
  ASSETS.states.stone_bricks = { variants: { '': { model: 'block/stone_bricks' } } };
  ASSETS.models['block/stone_bricks'] = {
    parent: 'block/cube_all',
    textures: { all: 'block/stone_bricks' },
  };
  ASSETS.states.oak_planks = { variants: { '': { model: 'block/planks' } } };
  ASSETS.models['block/planks'] = { parent: 'block/cube_all', textures: { all: 'block/oak_log' } };
  const mapping = readMapping({
    format: 1,
    blocks: {
      ...JSON.parse(JSON.stringify(MAPPING.blocks)),
      spruce_leaves: { textures: { all: 'oak_leaves' } },
    },
    tints: { oak_leaves: '#619961' },
  });
  const layout = {
    0: 'minecraft:stone_bricks',
    1: 'minecraft:spruce_leaves[distance=7,persistent=true,waterlogged=false]',
    2: 'minecraft:oak_leaves[distance=1,persistent=true,waterlogged=false]',
    3: 'minecraft:oak_planks',
    4: 'minecraft:stone_bricks[waterlogged=true]',
    5: 'minecraft:barrel[facing=up,open=false]',
  };
  const schem = readSchematic(schematic([6, 1, 1], (x) => layout[x]));
  const { report } = importSchematic(
    schem,
    mapping,
    { ...resources(), models: assets },
    { id: 'checked' },
  );
  const state = (s) => report.states.find((r) => r.state === parseState(s).key);
  assert.deepEqual(report.reference, {
    name: 'test models',
    minecraft: '1.19.2',
    dataVersion: 3120,
    compared: true,
  });
  assert.equal(state('stone_bricks').result, 'exact');
  // Spruce leaves: the game's one colour for them everywhere, and distance/persistent not read by the blockstate.
  assert.deepEqual(state('spruce_leaves[distance=7,persistent=true,waterlogged=false]').fidelity, {
    geometry: 'exact',
    material: 'exact',
    texture: 'exact',
    state: 'exact',
  });
  // Oak leaves take their biome's colour, which no schematic here gives.
  assert.deepEqual(
    state('oak_leaves[distance=1,persistent=true,waterlogged=false]').findings.map((f) => f.code),
    ['biome-tint'],
  );
  // The mapping names another tile than the game's model.
  assert.deepEqual(
    state('oak_planks').findings.map((f) => f.code),
    ['model-tile'],
  );
  assert.deepEqual(
    state('stone_bricks[waterlogged=true]').findings.map((f) => f.code),
    ['waterlogged'],
  );
  // No blockstate for barrel here: unverified, not exact.
  assert.equal(state('barrel[facing=up,open=false]').result, 'unverified');
  assert.match(
    state('barrel[facing=up,open=false]').unverified.geometry[0],
    /no blockstate for barrel/,
  );
});

/** Stone bricks and oak leaves checked against `assets`, with these tiles, this reference and this data version. */
const checked = ({ tiles = TILES, reference = assets, dataVersion } = {}) => {
  ASSETS.states.stone_bricks = { variants: { '': { model: 'block/stone_bricks' } } };
  ASSETS.models['block/stone_bricks'] = {
    parent: 'block/cube_all',
    textures: { all: 'block/stone_bricks' },
  };
  const layout = [
    'minecraft:stone_bricks',
    'minecraft:oak_leaves[distance=1,persistent=true,waterlogged=false]',
  ];
  const schem = readSchematic(
    schematic([2, 1, 1], (x) => layout[x], dataVersion === undefined ? {} : { dataVersion }),
  );
  const { report } = importSchematic(
    schem,
    MAPPING,
    { ...resources(tiles), models: reference },
    { id: 'checked' },
  );
  return { report, state: (s) => report.states.find((r) => r.state === parseState(s).key) };
};
const NONE = {
  geometry: 'unverified',
  material: 'unverified',
  texture: 'unverified',
  state: 'unverified',
};

test('a reference of another game, or one that does not say which, proves nothing: unverified, never exact', () => {
  // The folder may say 1.19.2; what counts is what the reference says of itself.
  for (const [reference, dataVersion, why] of [
    [
      { ...assets, version: { id: '1.20.1', dataVersion: 3465 } },
      undefined,
      /data version 3120, test models is Minecraft 1\.20\.1 \(data version 3465\)/,
    ],
    [{ ...assets, version: undefined }, undefined, /does not say which game it is/],
    [assets, 3465, /data version 3465, test models is Minecraft 1\.19\.2 \(data version 3120\)/],
    [assets, null, /schematic does not give its data version/],
  ]) {
    const { report, state } = checked({ reference, dataVersion });
    assert.equal(report.totals.exact.states, 0);
    assert.equal(report.reference.compared, false);
    assert.match(report.reference.why, why);
    assert.deepEqual(state('stone_bricks').fidelity, NONE);
    assert.match(state('stone_bricks').unverified.geometry[0], why);
    for (const aspect of ['geometry', 'material', 'texture', 'state'])
      assert.equal(report.aspects[aspect].exact.cells, 0, aspect);
  }
  // The same reference, of the schematic's game: compared.
  assert.equal(checked().state('stone_bricks').result, 'exact');
});

test("texture: other tiles than the reference's are named in texture only; shape, mapping and state stay proven", () => {
  // Any PNGs import; a stone_bricks tile that is not the reference's.
  const own = { ...TILES, stone_bricks: tilePng(121, 1) };
  const { state } = checked({ tiles: own });
  assert.deepEqual(state('stone_bricks').fidelity, {
    geometry: 'exact',
    material: 'exact',
    texture: 'approximated',
    state: 'exact',
  });
  assert.deepEqual(
    state('stone_bricks').findings.map((f) => [f.aspect, f.code]),
    [['texture', 'texture-differs']],
  );
  assert.match(state('stone_bricks').findings[0].detail, /256 of 256 pixels differ/);
  // A tile the reference does not have, or a reference without tiles: unverified, the rest still exact.
  const lacking = checked({
    reference: { ...assets, texture: (n) => (n === 'stone_bricks' ? undefined : TILES[n]) },
  }).state('stone_bricks');
  assert.deepEqual(lacking.fidelity, {
    geometry: 'exact',
    material: 'exact',
    texture: 'unverified',
    state: 'exact',
  });
  assert.match(lacking.unverified.texture[0], /has no tile "stone_bricks"/);
  const { texture: _, ...noTiles } = assets;
  assert.deepEqual(checked({ reference: noTiles }).state('stone_bricks').fidelity, {
    geometry: 'exact',
    material: 'exact',
    texture: 'unverified',
    state: 'exact',
  });
  // The same pixels in another file are the same tile.
  const decoded = decodeImage(TILES.stone_bricks);
  assert.equal(
    checked({
      tiles: { ...TILES, stone_bricks: encodeImage({ ...decoded, rgba: decoded.rgba.slice() }) },
    }).state('stone_bricks').fidelity.texture,
    'exact',
  );
});

test('cli --strict: a reference of another game is an error; without --strict the import is unverified', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-import-')),
    at = (...p) => join(dir, ...p);
  try {
    const ref = at('reference', 'assets', 'minecraft');
    for (const sub of ['blockstates', 'models/block', 'textures/block'])
      mkdirSync(join(ref, sub), { recursive: true });
    writeFileSync(
      at('reference', 'version.json'),
      JSON.stringify({ id: '1.20.1', world_version: 3465 }),
    );
    writeFileSync(
      join(ref, 'blockstates', 'stone_bricks.json'),
      JSON.stringify({ variants: { '': { model: 'block/stone_bricks' } } }),
    );
    writeFileSync(
      join(ref, 'models', 'block', 'stone_bricks.json'),
      JSON.stringify({
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: Object.fromEntries(SIDES.map((s) => [s, { texture: 'block/stone_bricks' }])),
          },
        ],
      }),
    );
    writeFileSync(join(ref, 'textures', 'block', 'stone_bricks.png'), TILES.stone_bricks);
    writeFileSync(
      at('in.schem'),
      schematic([1, 1, 1], () => 'minecraft:stone_bricks'),
    );
    writeFileSync(
      at('mapping.json'),
      JSON.stringify({
        format: 1,
        blocks: { stone_bricks: { textures: { all: 'stone_bricks' } } },
      }),
    );
    const cli = (out, ...extra) =>
      spawnSync(
        process.execPath,
        [
          'tools/mc-import/cli.ts',
          at('in.schem'),
          '--mapping',
          at('mapping.json'),
          '--resource-pack',
          at('reference'),
          '--out',
          at(out),
          ...extra,
        ],
        { encoding: 'utf8' },
      );
    const strict = cli('strict', '--strict');
    assert.equal(strict.status, 1, strict.stderr);
    assert.match(
      strict.stderr,
      /--strict: the schematic is data version 3120, .* is Minecraft 1\.20\.1 \(data version 3465\); not compared/,
    );
    const plain = cli('plain');
    assert.equal(plain.status, 0, plain.stderr);
    const report = JSON.parse(readFileSync(at('plain.import-report.json'), 'utf8'));
    assert.deepEqual(
      [report.totals.exact.cells, report.totals.unverified.cells, report.reference.compared],
      [0, 1, false],
    );
    // Told it is 1.19.2 (data version 3120), the same files prove the block.
    writeFileSync(
      at('reference', 'version.json'),
      JSON.stringify({ id: '1.19.2', world_version: 3120 }),
    );
    assert.equal(cli('same', '--strict').status, 0);
    assert.equal(
      JSON.parse(readFileSync(at('same.import-report.json'), 'utf8')).totals.exact.cells,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('other images, the same model and geometry: geometry, material and state against the reference stay as they are; only texture moves', () => {
  ASSETS.states.stone_bricks = { variants: { '': { model: 'block/stone_bricks' } } };
  ASSETS.models['block/stone_bricks'] = {
    parent: 'block/cube_all',
    textures: { all: 'block/stone_bricks' },
  };
  ASSETS.states.red_stained_glass = { variants: { '': { model: 'block/glass' } } };
  ASSETS.models['block/glass'] = {
    parent: 'block/cube_all',
    textures: { all: 'block/red_stained_glass' },
  };
  const layout = [
    'minecraft:stone_bricks',
    'minecraft:red_stained_glass',
    'minecraft:fire[age=0,east=false,north=false,south=false,up=false,west=false]',
    'minecraft:lantern[hanging=false,waterlogged=false]',
    'minecraft:oak_leaves[distance=1,persistent=true,waterlogged=false]',
  ];
  const schem = readSchematic(schematic([5, 1, 1], (x) => layout[x]));
  const run = (tiles) =>
    importSchematic(schem, MAPPING, { ...resources(tiles), models: assets }, { id: 'swapped' })
      .report;
  // The reference's glass is translucent and its fire animated; these are neither, and the stone is animated and translucent.
  const plain = Object.fromEntries(
    Object.keys(TILES).map((name, i) => [name, tilePng(10 + i, 200)]),
  );
  const odd = { ...plain, stone_bricks: tilePng(1, 2, { frames: 2, alpha: () => 100 }) };
  const structural = (report) =>
    report.states.map((s) => ({
      state: s.state,
      result: Object.fromEntries(Object.entries(s.fidelity).filter(([a]) => a !== 'texture')),
      findings: s.findings.filter((f) => f.aspect !== 'texture'),
    }));
  const base = run(TILES);
  for (const tiles of [plain, odd]) {
    const swapped = run(tiles);
    assert.deepEqual(structural(swapped), structural(base));
    for (const a of ['geometry', 'material', 'state'])
      assert.deepEqual(swapped.aspects[a], base.aspects[a], a);
    for (const s of swapped.states) assert.equal(s.fidelity.texture, 'approximated', s.state);
  }
  const state = (report, s) => report.states.find((r) => r.state === parseState(s).key);
  // What the game shows is what material is about: the reference's glass is translucent, its fire animated.
  assert.ok(
    state(run(plain), 'red_stained_glass').findings.some(
      (f) => f.aspect === 'material' && f.code === 'translucency',
    ),
  );
  assert.ok(
    state(
      run(plain),
      'fire[age=0,east=false,north=false,south=false,up=false,west=false]',
    ).findings.some((f) => f.aspect === 'material' && f.code === 'animation'),
  );
  // The given tile's own losses are its texture's.
  assert.deepEqual(
    state(run(odd), 'stone_bricks')
      .findings.map((f) => [f.aspect, f.code])
      .sort(),
    [
      ['texture', 'animation'],
      ['texture', 'texture-differs'],
      ['texture', 'translucency'],
    ],
  );
  assert.deepEqual(state(run(odd), 'stone_bricks').fidelity, {
    geometry: 'exact',
    material: 'exact',
    texture: 'approximated',
    state: 'exact',
  });
});
