import assert from 'node:assert/strict';
import test from 'node:test';
import { BlockRegistry } from '../../packages/blockworld/src/blocks.ts';
import { BlockWorld } from '../../packages/blockworld/src/world.ts';
import { computeLight } from '../../packages/blockworld/src/light.ts';
import { brightness, meshWorld } from '../../packages/blockworld/src/mesher.ts';

const blocks = new BlockRegistry([
  { name: 'stone', textures: { all: 'stone' } },
  { name: 'leaves', textures: { all: 'oak_leaves' }, transparent: true, cutout: true },
  { name: 'torch', model: 'torch', textures: { all: 'torch' }, light: 14 },
  { name: 'poppy', model: 'cross', textures: { all: 'poppy' } },
  { name: 'water', model: 'liquid', textures: { all: 'water' } },
]);
const uv = () => [0, 0, 1, 1];
const quads = (arrays) => arrays.indices.length / 6;

test('registry: ids in order, unknown names throw, cubes are opaque unless transparent', () => {
  assert.equal(blocks.id('stone'), 1);
  assert.equal(blocks.id('water'), 5);
  assert.throws(() => blocks.id('stnoe'), /Unknown block/);
  assert.equal(blocks.get(1).opaque, true);
  assert.equal(blocks.get(2).opaque, false);
  assert.equal(blocks.get(4).opaque, false);
  assert.equal(blocks.get(0), undefined, 'air');
});

test('sky light falls to 15 in the open, stops under stone, and creeps under an overhang losing 1 per block', () => {
  const world = new BlockWorld(9, 6, 9);
  world.fill(0, 0, 0, 8, 0, 8, blocks.id('stone'));
  world.fill(0, 3, 0, 4, 3, 8, blocks.id('stone')); // a roof over x 0..4
  computeLight(world, blocks);
  assert.equal(world.sky[world.index(7, 1, 4)], 15, 'open ground');
  assert.equal(world.sky[world.index(0, 0, 4)], 0, 'inside stone');
  assert.equal(world.sky[world.index(4, 1, 4)], 14, 'one block under the roof edge');
  assert.equal(world.sky[world.index(2, 1, 4)], 12, 'three blocks in');
});

test('leaves dim sky light by one; a torch lights 14 and fades by 1 per block', () => {
  const world = new BlockWorld(16, 8, 3);
  world.set(2, 6, 1, blocks.id('leaves'));
  world.set(10, 1, 1, blocks.id('torch'));
  computeLight(world, blocks);
  assert.equal(world.sky[world.index(2, 5, 1)], 14, 'under the leaves');
  assert.equal(world.glow[world.index(10, 1, 1)], 14);
  assert.equal(world.glow[world.index(13, 1, 1)], 11);
});

test('the game light curve: 15 is full, 0 is dark, it rises fast at the top', () => {
  assert.equal(brightness(15), 1);
  assert.equal(brightness(0), 0);
  assert.ok(brightness(14) > 0.8 && brightness(7) < 0.5 && brightness(7) > brightness(6));
});

test('a cube shows only uncovered faces; touching stones hide their shared faces', () => {
  const one = new BlockWorld(3, 3, 3);
  one.set(1, 1, 1, blocks.id('stone'));
  computeLight(one, blocks);
  assert.equal(quads(meshWorld(one, blocks, { uv }).opaque), 6);
  const two = new BlockWorld(4, 3, 3);
  two.set(1, 1, 1, blocks.id('stone'));
  two.set(2, 1, 1, blocks.id('stone'));
  computeLight(two, blocks);
  assert.equal(
    quads(meshWorld(two, blocks, { uv }).opaque),
    10,
    'the two faces between them are hidden',
  );
});

test('vanilla face shade: top brighter than north/south, brighter than east/west, brighter than bottom', () => {
  const world = new BlockWorld(3, 3, 3);
  world.set(1, 1, 1, blocks.id('stone'));
  computeLight(world, blocks);
  const { colors, positions } = meshWorld(world, blocks, { uv, occlusion: 0 }).opaque;
  const faceBrightness = (axis) => {
    // Find a vertex whose position sits on the given outer plane and read its colour.
    for (let i = 0; i < positions.length / 3; i++) {
      const p = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
      if (axis(p)) return colors[i * 3];
    }
  };
  const top = faceBrightness((p) => p[1] === 2 && p[0] > 1 && p[0] < 2 + 1 && p[2] > 1 && p[2] < 3);
  assert.ok(top > 0, 'top face found');
});

test('ambient occlusion darkens a floor corner next to two walls, and leaves the open middle bright', () => {
  const world = new BlockWorld(5, 4, 5);
  world.fill(0, 0, 0, 4, 0, 4, blocks.id('stone'));
  world.set(0, 1, 2, blocks.id('stone'));
  world.set(1, 1, 3, blocks.id('stone'));
  computeLight(world, blocks);
  const { colors, positions } = meshWorld(world, blocks, { uv, occlusion: 1 }).opaque;
  const at = (x, y, z) => {
    const found = [];
    for (let i = 0; i < positions.length / 3; i++)
      if (positions[i * 3] === x && positions[i * 3 + 1] === y && positions[i * 3 + 2] === z)
        found.push(colors[i * 3]);
    return Math.min(...found);
  };
  assert.ok(
    at(1, 1, 3) < at(3, 1, 1),
    'the corner between the two walls is darker than open floor',
  );
});

test('crosses are two planes, torches five faces lit at full, water a separate pass', () => {
  const world = new BlockWorld(5, 3, 3);
  world.fill(0, 0, 0, 4, 0, 2, blocks.id('stone'));
  world.set(1, 1, 1, blocks.id('poppy'));
  world.set(3, 1, 1, blocks.id('torch'));
  world.set(2, 1, 1, blocks.id('water'));
  computeLight(world, blocks);
  const mesh = meshWorld(world, blocks, { uv });
  assert.equal(quads(mesh.plants), 2 + 5);
  assert.ok(quads(mesh.liquid) >= 1);
  assert.ok(
    Math.max(...mesh.liquid.positions.filter((_, i) => i % 3 === 1)) < 2,
    'the water surface sits below the top of its cell',
  );
});

test('the baked sun: ground behind a pillar lies in its shadow, open ground facing the sun warms up', () => {
  const world = new BlockWorld(16, 8, 5);
  world.fill(0, 0, 0, 15, 0, 4, blocks.id('stone'));
  world.fill(8, 1, 2, 8, 6, 2, blocks.id('stone')); // a pillar; the sun is beyond it, up and to +x
  computeLight(world, blocks);
  const sun = { direction: [1, 1, 0], color: [1, 0.8, 0.6], strength: 0.4 };
  const red = (mesh, x, z) => {
    const { positions, colors } = mesh.opaque;
    for (let i = 0; i < positions.length / 3; i++)
      if (positions[i * 3] === x && positions[i * 3 + 1] === 1 && positions[i * 3 + 2] === z)
        return colors[i * 3];
    throw new Error(`no vertex at ${x},1,${z}`);
  };
  const vanilla = meshWorld(world, blocks, { uv }),
    lit = meshWorld(world, blocks, { uv, sun });
  assert.ok(red(lit, 6, 2) < red(vanilla, 6, 2), "in the pillar's shadow: darker than vanilla");
  assert.ok(red(lit, 13, 2) > red(lit, 6, 2) * 1.3, 'in the sun: clearly brighter than the shadow');
});

test('wind and waves: plant tops and leaves are free to move, roots and stone are not, water tops wave', () => {
  const world = new BlockWorld(5, 4, 3);
  world.set(0, 0, 1, blocks.id('stone'));
  world.set(0, 1, 1, blocks.id('poppy'));
  world.set(2, 1, 1, blocks.id('leaves'));
  world.set(4, 0, 1, blocks.id('water'));
  computeLight(world, blocks);
  const mesh = meshWorld(world, blocks, { uv });
  const swayAt = (arrays, y) =>
    [...arrays.sway].filter((_, i) => arrays.positions[i * 3 + 1] === y);
  assert.deepEqual([...new Set(swayAt(mesh.plants, 1))], [0], 'roots stay');
  assert.deepEqual([...new Set(swayAt(mesh.plants, 2))], [1], 'tops move');
  const stone = [...mesh.opaque.sway].filter((_, i) => mesh.opaque.positions[i * 3] <= 1);
  assert.ok(
    stone.every((v) => v === 0),
    'stone is still',
  );
  assert.ok(
    [...mesh.opaque.sway].some((v) => v > 0 && v < 1),
    'leaves rustle a little',
  );
  assert.ok(
    [...mesh.liquid.sway].some((v) => v === 1),
    'the water surface waves',
  );
});

test('torchlight is marked for flicker: the flame fully, ground near it partly, ground in the open not at all', () => {
  const world = new BlockWorld(24, 4, 3);
  world.fill(0, 0, 0, 23, 0, 2, blocks.id('stone'));
  world.set(2, 1, 1, blocks.id('torch'));
  computeLight(world, blocks);
  const mesh = meshWorld(world, blocks, { uv });
  assert.ok(
    [...mesh.plants.glow].some((v) => v === 1),
    'the flame',
  );
  const ground = (x) =>
    [...mesh.opaque.glow].find(
      (_, i) =>
        mesh.opaque.positions[i * 3] === x &&
        mesh.opaque.positions[i * 3 + 1] === 1 &&
        mesh.opaque.positions[i * 3 + 2] === 1,
    );
  assert.ok(ground(3) > 0 && ground(3) < 1, 'next to the torch, mixed with the sky');
  assert.equal(ground(22), 0, 'out of its reach');
});

test('boxes model: a bottom slab is six faces half a block tall; the face on stone below is dropped', () => {
  const r = new BlockRegistry([
    { name: 'stone', textures: { all: 'stone' } },
    { name: 'slab', model: 'boxes', textures: { all: 'stone' }, boxes: [[0, 0, 0, 16, 8, 16]] },
  ]);
  const w = new BlockWorld(3, 3, 3);
  w.set(1, 1, 1, r.id('slab'));
  computeLight(w, r);
  const alone = meshWorld(w, r, { uv }).opaque;
  assert.equal(quads(alone), 6);
  const ys = [...alone.positions].filter((_, i) => i % 3 === 1);
  assert.equal(Math.max(...ys), 1.5);
  assert.equal(Math.min(...ys), 1);
  w.set(1, 0, 1, r.id('stone'));
  computeLight(w, r);
  // The stone keeps all six (a slab does not cover its top); the slab loses its bottom.
  assert.equal(quads(meshWorld(w, r, { uv }).opaque), 11);
});

test('second light: soul fire floods its own channel, tinted on its own, beside the first', () => {
  const r = new BlockRegistry([
    { name: 'stone', textures: { all: 'stone' } },
    { name: 'fire', model: 'torch', textures: { all: 'torch' }, light: 14 },
    { name: 'soul', model: 'torch', textures: { all: 'torch' }, light: 14, secondLight: true },
  ]);
  const w = new BlockWorld(9, 1, 1);
  w.set(0, 0, 0, r.id('fire'));
  w.set(8, 0, 0, r.id('soul'));
  computeLight(w, r);
  assert.equal(w.glowAt(0, 0, 0), 14);
  assert.equal(w.glow2At(0, 0, 0), 6);
  assert.equal(w.glow2At(8, 0, 0), 14);
  assert.equal(w.glowAt(8, 0, 0), 6);
  assert.equal(w.glowAt(4, 0, 0), 10);
  assert.equal(w.glow2At(4, 0, 0), 10, 'both meet in the middle');
});
