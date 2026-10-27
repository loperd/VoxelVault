import assert from 'node:assert/strict';
import test from 'node:test';
import { BlockRegistry } from '../../packages/blockworld/src/blocks.ts';
import { BlockWorld } from '../../packages/blockworld/src/world.ts';
import { computeLight } from '../../packages/blockworld/src/light.ts';
import { meshWorld } from '../../packages/blockworld/src/mesher.ts';
import { packAtlas, TILE } from '../../packages/blockworld/src/atlas.ts';
import { packFolder, png } from './pack-fixture.mjs';

// Each tile is its own column of a 1-high atlas: a vertex's u tells which tile it shows.
const TILES = ['n', 's', 'e', 'w', 'u', 'd', 'all', 'side', 'top', 'bottom', 'plank', 'brick'];
const uv = (name) => {
  const i = TILES.indexOf(name);
  assert.ok(i >= 0, `unknown tile ${name}`);
  return [i, 0, i + 1, 1];
};

/** The quads of a mesh: their four corners, the tile they show, and which side of the cell they face. */
function quads(arrays) {
  const out = [];
  for (let q = 0; q < arrays.positions.length / 12; q++) {
    const p = (i) => [0, 1, 2].map((k) => arrays.positions[(q * 4 + i) * 3 + k]),
      corners = [0, 1, 2, 3].map(p);
    const us = [0, 1, 2, 3].map((i) => arrays.uvs[(q * 4 + i) * 2]),
      vs = [0, 1, 2, 3].map((i) => arrays.uvs[(q * 4 + i) * 2 + 1]);
    const a = corners[0],
      b = corners[1],
      c = corners[2];
    const e1 = b.map((v, k) => v - a[k]),
      e2 = c.map((v, k) => v - a[k]);
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const side =
      n[0] > 0
        ? 'east'
        : n[0] < 0
          ? 'west'
          : n[1] > 0
            ? 'up'
            : n[1] < 0
              ? 'down'
              : n[2] > 0
                ? 'south'
                : 'north';
    out.push({ corners, us, vs, side, tile: TILES[Math.floor(Math.min(...us))] });
  }
  return out;
}

function single(definition, options = {}) {
  const blocks = new BlockRegistry([definition], { strict: true });
  const world = new BlockWorld(3, 3, 3);
  world.set(1, 1, 1, 1);
  computeLight(world, blocks);
  return quads(meshWorld(world, blocks, { uv, occlusion: 0, ...options }).opaque);
}

test('six sides, six tiles, each on the side it names (north −z, south +z, east +x, west −x)', () => {
  const faces = single({
    name: 'compass',
    textures: { north: 'n', south: 's', east: 'e', west: 'w', up: 'u', down: 'd' },
  });
  assert.equal(faces.length, 6);
  const bySide = Object.fromEntries(faces.map((f) => [f.side, f.tile]));
  assert.deepEqual(bySide, { north: 'n', south: 's', east: 'e', west: 'w', up: 'u', down: 'd' });
  // Seen from outside, a side's texture is upright and not mirrored: u grows to the viewer's right.
  for (const face of faces.filter((f) => !['up', 'down'].includes(f.side))) {
    const [bl, br] = face.corners,
      right = { north: [-1, 0, 0], south: [1, 0, 0], east: [0, 0, -1], west: [0, 0, 1] }[face.side];
    const step = br.map((v, k) => v - bl[k]);
    assert.ok(step[0] * right[0] + step[2] * right[2] > 0, `${face.side}: u runs to the right`);
    assert.ok(
      face.vs[3] > face.vs[0] && face.corners[3][1] > face.corners[0][1],
      `${face.side}: v runs up`,
    );
  }
});

test('fallbacks: a side takes its own name, then top / bottom (then top) / side, then all', () => {
  const sides = (definition) =>
    Object.fromEntries(single({ name: 'b', textures: definition }).map((f) => [f.side, f.tile]));
  assert.deepEqual(sides({ all: 'all', top: 'top' }), {
    east: 'all',
    west: 'all',
    south: 'all',
    north: 'all',
    up: 'top',
    down: 'all',
  });
  assert.deepEqual(sides({ side: 'side', top: 'top' }), {
    east: 'side',
    west: 'side',
    south: 'side',
    north: 'side',
    up: 'top',
    down: 'top',
  });
  assert.deepEqual(sides({ side: 'side', top: 'top', bottom: 'bottom', north: 'n', up: 'u' }), {
    east: 'side',
    west: 'side',
    south: 'side',
    north: 'n',
    up: 'u',
    down: 'bottom',
  });
});

test('strict (a pack): a side without a tile is an error; the built-in worlds keep their stone', () => {
  assert.throws(
    () => new BlockRegistry([{ name: 'odd', textures: { top: 'u' } }], { strict: true }),
    /"odd" has no texture for its north side/,
  );
  const legacy = new BlockRegistry([{ name: 'odd', textures: { top: 'u' } }]).get(1);
  assert.equal(legacy.textures.side, 'stone');
  assert.equal(legacy.textures.north, 'stone');
  assert.equal(legacy.textures.up, 'u');
  assert.equal(legacy.textures.bottom, 'u', 'bottom falls back to top, as before');
});

test('parts: the old BlockBox tuples and { from, to } mesh the same', () => {
  const tuple = single({
    name: 'slab',
    model: 'boxes',
    textures: { all: 'all' },
    boxes: [
      [0, 0, 0, 16, 8, 16],
      [4, 8, 4, 12, 16, 12],
    ],
  });
  const parts = single({
    name: 'slab',
    model: 'boxes',
    textures: { all: 'all' },
    boxes: [
      { from: [0, 0, 0], to: [16, 8, 16] },
      { from: [4, 8, 4], to: [12, 16, 12] },
    ],
  });
  assert.deepEqual(parts, tuple);
  // Without a UV of its own a face shows the part of the tile its box covers: a half slab's side the lower half.
  const east = tuple.find((f) => f.side === 'east' && f.corners.every((c) => c[0] === 2));
  assert.deepEqual([Math.min(...east.vs), Math.max(...east.vs)], [0, 0.5]);
});

test("a part face takes its own tile and UV (pixels from the tile's top-left), others the block's tile per side", () => {
  const faces = single({
    name: 'bench',
    model: 'boxes',
    textures: { all: 'plank', up: 'top' },
    boxes: [
      {
        from: [1, 0, 3],
        to: [3, 6, 13],
        faces: { east: { texture: 'brick', uv: [0, 10, 10, 16] }, north: { uv: [2, 0, 4, 16] } },
      },
    ],
  });
  const east = faces.find((f) => f.side === 'east'),
    north = faces.find((f) => f.side === 'north'),
    up = faces.find((f) => f.side === 'up'),
    west = faces.find((f) => f.side === 'west');
  assert.equal(east.tile, 'brick');
  const at = TILES.indexOf('brick');
  assert.deepEqual([Math.min(...east.us) - at, Math.max(...east.us) - at], [0, 10 / 16]);
  // v runs up from the tile's bottom: pixels 10..16 from the top are 0..6/16 from the bottom.
  assert.deepEqual([Math.min(...east.vs), Math.max(...east.vs)], [0, 6 / 16]);
  assert.equal(north.tile, 'plank');
  assert.deepEqual(
    [
      Math.min(...north.us) - TILES.indexOf('plank'),
      Math.max(...north.us) - TILES.indexOf('plank'),
    ],
    [2 / 16, 4 / 16],
  );
  assert.equal(
    up.tile,
    'top',
    "a face with nothing of its own takes the block's tile for that side",
  );
  assert.equal(west.tile, 'plank');
  for (const face of faces) for (const v of [...face.us, ...face.vs]) assert.ok(Number.isFinite(v));
});

test("packAtlas: a pack's tiles in its own texture; an unknown tile throws; two atlases share nothing", () => {
  const red = new Uint8Array(TILE * TILE * 4).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0));
  const marked = new Uint8Array(TILE * TILE * 4);
  marked.set([0, 255, 0, 255], 0); // top-left pixel green
  const a = packAtlas([
    { name: 'red', rgba: red },
    { name: 'marked', rgba: marked },
  ]);
  const b = packAtlas([{ name: 'red', rgba: marked }]);
  assert.notEqual(a.texture, b.texture);
  assert.throws(() => a.uv('stone'), /no tile "stone"/);
  const [u0, v0, u1, v1] = a.uv('marked'),
    { width, height, data } = a.texture.image;
  assert.ok(u0 > 0 && u1 <= 1 && v0 >= 0 && v1 <= 1 && u1 > u0 && v1 > v0);
  // The tile's top-left pixel sits at its top row: the highest v, as the quad's top-left corner reads it.
  const x = Math.round(u0 * width),
    y = Math.round(v1 * height) - 1;
  assert.deepEqual(
    [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)],
    [0, 255, 0, 255],
  );
  assert.equal(
    b.texture.image.data[15 * b.texture.image.width * 4 + 1],
    255,
    'the other atlas holds its own pixels',
  );
  assert.throws(() => packAtlas([{ name: 'x', rgba: new Uint8Array(4) }]), /not 16×16 RGBA/);
  a.dispose();
  b.dispose();
});

// ── Open sides: a pack's structure stands in the open (docs §4.2, edge light) ───────────────────────

/** Brightness of each side of the block at (x, y, z): the mean of its quad's vertex colours. */
function sides(world, registry, at) {
  const arrays = meshWorld(world, registry, { uv, occlusion: 0, minimum: 0.05 }).opaque,
    out = {};
  quads(arrays).forEach((quad, q) => {
    const inside = quad.corners.every((c) =>
      c.every((v, k) => v >= at[k] - 1e-6 && v <= at[k] + 1 + 1e-6),
    );
    if (inside)
      out[quad.side] = [0, 1, 2, 3].reduce((sum, i) => sum + arrays.colors[(q * 4 + i) * 3], 0) / 4;
  });
  return out;
}
const stone = () =>
  new BlockRegistry([{ name: 'stone', textures: { all: 'all' } }], { strict: true });

test('open sides: a block on the edge of an open box is lit on its outer side; a closed box (every built-in world) is as before', () => {
  // One layer up, so every cell its west side samples is beside the box (below the box is dark either way).
  const registry = stone(),
    edge = [0, 1, 1];
  const build = (openSides) => {
    const world = new BlockWorld(3, 3, 3, [0, 0, 0], { openSides });
    world.set(...edge, 1);
    computeLight(world, registry);
    return world;
  };
  const closed = build(undefined),
    open = build(true);
  assert.equal(closed.skyAt(-1, 0, 1), 0, 'closed: dark beside the box');
  assert.equal(closed.skyAt(0, 3, 1), 15, 'closed: open sky above it');
  assert.equal(open.skyAt(-1, 0, 1), 15);
  assert.equal(open.skyAt(-1, -1, 1), 0, 'below the box stays dark');
  const shut = sides(closed, registry, edge),
    lit = sides(open, registry, edge);
  assert.ok(
    Math.abs(shut.west - 0.05 * 0.6) < 1e-6,
    `closed: the outer side at the minimum, east/west shade .6 (${shut.west})`,
  );
  assert.ok(
    Math.abs(lit.west - 0.6) < 1e-6,
    `open: the outer side in full sky light, shade .6 (${lit.west})`,
  );
  // Smooth light averages the cells round a corner: closed, the top's outer corners took the dark beside the box too.
  assert.ok(
    Math.abs(lit.up - 1) < 1e-6 && shut.up < lit.up,
    `the top: open ${lit.up}, closed ${shut.up}`,
  );
});

test('open sides: light comes in under an overhang from the side; a closed room in the open stays dark', () => {
  const registry = stone(),
    at = (world, x, y, z) => world.sky[world.index(x, y, z)];
  // A roof over the whole 5×3×5 box at y 2: no light straight down below it.
  const roofed = (openSides) => {
    const world = new BlockWorld(5, 3, 5, [0, 0, 0], { openSides });
    world.fill(0, 2, 0, 4, 2, 4, 1);
    computeLight(world, registry);
    return world;
  };
  assert.equal(at(roofed(false), 0, 1, 2), 0, 'closed: under the roof is dark');
  const open = roofed(true);
  assert.equal(at(open, 0, 1, 2), 14, 'open: the cell on the edge takes 14 from the sky beside it');
  assert.equal(at(open, 2, 1, 2), 12, 'and it spreads in, one less per cell');
  // A walled room (stone all round, roof and floor) in the middle of an open box: nothing gets in.
  const world = new BlockWorld(7, 5, 7, [0, 0, 0], { openSides: true });
  world.fill(1, 0, 1, 5, 4, 5, 1);
  world.fill(2, 1, 2, 4, 3, 4, 0);
  computeLight(world, registry);
  assert.equal(at(world, 3, 2, 3), 0, 'the closed room stays dark');
  assert.equal(at(world, 0, 2, 3), 15, 'outside it, the open air is lit');
});
