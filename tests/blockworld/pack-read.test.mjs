import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readWorldPack,
  packFilesAt,
  pathProblem,
  PackError,
} from '../../packages/blockworld/src/pack/read.ts';
import { loadPackAssets } from '../../packages/blockworld/src/pack/assets.ts';
import { glb, memoryFiles, packFolder, png, triangleGlb, never } from './pack-fixture.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const sample = await packFolder();
const read = (options = {}, limits) =>
  readWorldPack(memoryFiles(sample, options), { signal: never, ...(limits ? { limits } : {}) });
/** The problems of a pack that must not be read, as "path: message" lines. */
async function problems(options, limits) {
  const error = await read(options, limits).then(
    () => undefined,
    (e) => e,
  );
  assert.ok(error instanceof PackError, `expected a PackError, got ${error}`);
  return error.problems.map((p) => `${p.path}: ${p.message}`);
}
const has = (list, pattern) =>
  assert.ok(
    list.some((line) => pattern.test(line)),
    `no problem matching ${pattern} in:\n${list.join('\n')}`,
  );

test('the sample pack reads in Node, with no three.js and no app: read.ts imports only types, and the lighting contract that imports nothing', async () => {
  const source = await readFile(join(ROOT, 'packages/blockworld/src/pack/read.ts'), 'utf8');
  const imports = source.match(/^import\b[^;]*;/gm) ?? [];
  assert.ok(
    imports.every(
      (statement) =>
        statement.startsWith('import type ') || statement.endsWith(`from '../lighting-preset.ts';`),
    ),
    `runtime imports in read.ts: ${imports.join(' | ')}`,
  );
  const contract = await readFile(join(ROOT, 'packages/blockworld/src/lighting-preset.ts'), 'utf8');
  assert.deepEqual(contract.match(/^import .*$/gm) ?? [], [], 'lighting-preset.ts imports nothing');
  const pack = await read();
  assert.equal(pack.id, 'sample-ruin');
  assert.equal(pack.format, 1);
  assert.equal(pack.blocks.length, 7);
  assert.deepEqual([...pack.cameras.keys()], ['hero', 'high']);
  assert.equal(pack.structure.sides, 'open');
  assert.match(pack.hash, /^[0-9a-f]{64}$/);
});

test('places are in cells of the structure; the scene has them with the origin added', async () => {
  const pack = await read();
  assert.deepEqual(pack.structure.origin, [-6, 0, -6]);
  const altar = pack.markers.get('altar');
  assert.deepEqual(altar.at, [-0.5, 3, -0.5], 'altar [5.5, 3, 5.5] + origin');
  assert.deepEqual(altar.front, [0, 1], '"south" is +z');
  assert.deepEqual(altar.tags, ['guest']);
  assert.deepEqual(
    pack.cameras.get('hero').look,
    altar.at,
    'a camera may look at a marker by name',
  );
  assert.deepEqual(pack.objects[0].at, [-2.5, 2, -2.5]);
  assert.deepEqual(
    pack.environment.light.from,
    pack.markers.get('lamp').at,
    'the key comes from the lamp marker',
  );
});

test('a read pack is frozen, owns its bytes, and hands out only copies', async () => {
  const files = new Map([...sample].map(([path, data]) => [path, data.slice(0)])),
    source = memoryFiles(files);
  const pack = await readWorldPack(source, { signal: never });
  // What the caller handed over and keeps is not the pack's: changing it changes nothing.
  new Uint8Array(files.get('structure.u16')).fill(0);
  assert.ok(
    pack.structure.cells().some((v) => v > 0),
    'the pack kept its own copy of the cells',
  );
  const cells = pack.structure.cells();
  cells.fill(0);
  assert.ok(
    pack.structure.cells().some((v) => v > 0),
    'cells() is a copy',
  );
  const tile = new Uint8Array(pack.texture('ruin_bricks'));
  tile.fill(0);
  assert.equal(
    new Uint8Array(pack.texture('ruin_bricks'))[1],
    80,
    'texture() is a copy (the PNG signature is intact)',
  );
  assert.ok(
    Object.isFrozen(pack) &&
      Object.isFrozen(pack.blocks) &&
      Object.isFrozen(pack.blocks[0].textures) &&
      Object.isFrozen(pack.environment.light),
  );
  assert.throws(() => {
    pack.blocks.push({});
  }, TypeError);
  assert.equal(typeof pack.markers.set, 'undefined', 'markers can only be read');
  assert.throws(() => pack.texture('nope'), /no texture "nope"/);
});

test('the hash depends on the bytes alone: not on the order files are read in, and one byte changes it', async () => {
  const first = await read();
  const shuffled = new Map([...sample].reverse());
  const second = await readWorldPack(memoryFiles(shuffled), { signal: never });
  assert.equal(second.hash, first.hash);
  const changed = new Uint8Array(sample.get('textures/ruin_moss.png').slice(0));
  changed[changed.length - 20] ^= 1;
  // A changed byte inside the image data breaks the PNG's CRC only at decode time; the header is fine.
  const third = await read({ swap: { 'textures/ruin_moss.png': changed } });
  assert.notEqual(third.hash, first.hash);
});

test('structure.u16: little-endian, x fastest, exact length; blocks past the palette are refused', async () => {
  const pack = await read(),
    cells = pack.structure.cells(),
    [sx, sy] = pack.structure.size;
  const raw = new DataView(sample.get('structure.u16'));
  // Cell (9, 4, 9) is the lamp, block 7.
  const i = 9 + sx * (4 + sy * 9);
  assert.equal(cells[i], 7);
  assert.equal(raw.getUint16(2 * i, true), 7);
  for (const delta of [-2, 2]) {
    const data = new Uint8Array(sample.get('structure.u16').byteLength + delta);
    has(
      await problems({ swap: { 'structure.u16': data } }),
      /structure.cells.*bytes; a 12×8×12 structure is exactly 2304/,
    );
  }
  const bad = new Uint8Array(sample.get('structure.u16').slice(0));
  new DataView(bad.buffer).setUint16(2 * 5, 10, true);
  has(
    await problems({ swap: { 'structure.u16': bad } }),
    /past the 7 defined \(first at x 5, y 0, z 0: 10\)/,
  );
});

test('cells and layers are exclusive; layers read into the same order as cells', async () => {
  has(
    await problems({
      edit: (j) => {
        j.structure.layers = [];
      },
    }),
    /pack.structure: exactly one of "cells" and "layers"/,
  );
  has(
    await problems({
      edit: (j) => {
        delete j.structure.cells;
      },
    }),
    /pack.structure: exactly one of "cells" and "layers"/,
  );
  const pack = await read({
    edit: (j) => {
      j.structure = {
        size: [3, 2, 2],
        legend: { '#': 'bricks', t: 'turf' },
        layers: [
          ['tt#', 't.t'],
          ['..#', '...'],
        ],
      };
      j.objects = [];
      j.markers = { altar: { at: [1, 1, 1] }, lamp: { at: [1, 1, 1] } };
    },
  });
  // i = x + 3 (y + 2 z): z 0 is "tt#" then "..#", z 1 is "t.t" then "...".
  assert.deepEqual([...pack.structure.cells()], [1, 1, 2, 0, 0, 2, 1, 0, 1, 0, 0, 0]);
  has(
    await problems({
      edit: (j) => {
        j.structure = { size: [3, 1, 1], legend: { '#': 'bricks' }, layers: [['#x#']] };
        j.objects = [];
        j.markers = {};
        j.cameras = { hero: { eye: [0, 0, 0], look: [1, 1, 1] } };
        j.environment.light.from = undefined;
      },
    }),
    /"x" at x 1 is not in the legend/,
  );
});

test('a missing texture, block, model or marker is an error, never stone', async () => {
  const list = await problems({
    edit: (j) => {
      j.blocks[1].textures.all = 'ruin_brick';
      j.blocks[5].parts[1].faces.east.texture = 'nope';
      j.objects[0].model = 'chair';
      j.cameras.hero.look = 'altr';
      j.environment.light.from = 'sun';
    },
  });
  has(list, /pack.blocks\[1\].textures.all: no texture "ruin_brick"/);
  has(list, /parts\[1\].faces.east.texture: no texture "nope"/);
  has(list, /pack.objects\[0\].model: no model "chair"/);
  has(list, /pack.cameras.hero.look: no marker "altr"/);
  has(list, /light.from: no marker "sun"/);
  assert.ok(list.length >= 5, 'every problem is reported, not only the first');
  has(
    await problems({
      edit: (j) => {
        j.blocks[0].textures = { top: 'ruin_turf' };
      },
    }),
    /no texture for the north side/,
  );
  has(
    await problems({ swap: { 'textures/ruin_floor.png': undefined } }),
    /textures\/ruin_floor.png: could not be read/,
  );
});

test('the format is checked apart from the version; unknown keys are refused', async () => {
  has(
    await problems({
      edit: (j) => {
        j.format = 2;
      },
    }),
    /pack.format: format 2; this engine reads format 1/,
  );
  has(
    await problems({
      edit: (j) => {
        j.requires.blockworld = 2;
      },
    }),
    /requires.blockworld/,
  );
  await read({
    edit: (j) => {
      j.version = 'anything at all';
    },
  });
  has(
    await problems({
      edit: (j) => {
        j.blocks[0].colour = 'red';
      },
    }),
    /pack.blocks\[0\].colour: unknown key/,
  );
});

test('paths stay inside the pack: no "..", no absolute path, no URL, no backslash', async () => {
  for (const [path, pattern] of [
    ['../x.png', /not normalised/],
    ['/etc/x.png', /absolute/],
    ['http://evil.test/x.png', /a URL/],
    ['data:image/png;base64,AA.png', /a URL/],
    ['textures\\a.png', /backslash/],
    ['textures/%2e%2e/a.png', /characters/],
    ['textures//a.png', /not normalised/],
  ]) {
    assert.match(pathProblem(path) ?? '', pattern, path);
    has(
      await problems({
        edit: (j) => {
          j.textures.ruin_bricks = path;
        },
      }),
      /pack.textures.ruin_bricks/,
    );
  }
  has(
    await problems({
      edit: (j) => {
        j.textures.ruin_bricks = 'textures/ruin_bricks.jpg';
      },
    }),
    /expected a .png file/,
  );
});

test('packFilesAt reads only inside its folder of the same origin', async () => {
  const fetched = [],
    original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetched.push(String(url));
    assert.equal(init.redirect, 'error');
    return new Response(new Uint8Array([1]));
  };
  try {
    const files = packFilesAt('https://game.test/packs/ruin');
    await files('textures/a.png', never);
    assert.deepEqual(fetched, ['https://game.test/packs/ruin/textures/a.png']);
    await assert.rejects(files('../other/pack.json', never), /not normalised/);
    await assert.rejects(files('https://evil.test/a.png', never), /a URL/);
    globalThis.location = { href: 'https://game.test/', origin: 'https://game.test' };
    assert.throws(() => packFilesAt('https://evil.test/packs/'), /page's own origin/);
  } finally {
    globalThis.fetch = original;
    delete globalThis.location;
  }
});

test('PNG: a real PNG of the tile size, by its signature and header', async () => {
  const red = () => [255, 0, 0, 255];
  has(
    await problems({ swap: { 'textures/ruin_bricks.png': png(17, 16, red) } }),
    /17×16; a tile is 16×16/,
  );
  has(
    await problems({
      swap: { 'textures/ruin_bricks.png': Buffer.from('GIF89a not a png at all, but long enough') },
    }),
    /not a PNG \(signature\)/,
  );
  await read({ swap: { 'textures/ruin_bricks.png': png(16, 16, red, { type: 2 }) } });
});

test('GLB: everything inside, only allowed extensions, triangles counted over the scene and over placements', async () => {
  const swap = (data) => ({ swap: { 'models/brazier.glb': data } });
  has(await problems(swap(triangleGlb({ uri: 'https://evil.test/a.bin' }))), /buffer 0 has a URI/);
  has(
    await problems(swap(triangleGlb({ extensions: ['KHR_draco_mesh_compression'] }))),
    /uses KHR_draco_mesh_compression/,
  );
  has(await problems(swap(Buffer.from('glTF but not really a binary gltf'))), /not a GLB|version/);
  // One triangle on 10 nodes is 10 triangles and 10 nodes; the brazier is placed twice in the sample: 20 of each.
  has(
    await problems(swap(triangleGlb({ nodes: 10 })), { modelTriangles: 9 }),
    /10 triangles, more than 9/,
  );
  has(
    await problems(swap(triangleGlb({ nodes: 10 })), { packTriangles: 19 }),
    /20 triangles placed .* more than 19/,
  );
  has(
    await problems(swap(triangleGlb({ nodes: 10 })), { packNodes: 19 }),
    /20 nodes placed .* more than 19/,
  );
  has(await problems(swap(triangleGlb({ nodes: 10 })), { modelNodes: 9 }), /10 nodes, more than 9/);
  await read(swap(triangleGlb({ nodes: 10 })), {
    modelTriangles: 10,
    packTriangles: 20,
    packNodes: 20,
  });
});

/** A valid one-triangle glTF (JSON and BIN) to break one thing at a time. */
function triangle() {
  const bin = Buffer.alloc(36);
  bin.writeFloatLE(1, 12);
  bin.writeFloatLE(1, 28);
  return {
    bin,
    json: {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
    },
  };
}
const broken = (edit) => {
  const { json, bin } = triangle();
  edit(json);
  return glb(json, bin);
};
const glbProblems = (data, limits) => problems({ swap: { 'models/brazier.glb': data } }, limits);

test('GLB: the container as the loader reads it — one JSON chunk first, at most one BIN, nothing else', async () => {
  await read({ swap: { 'models/brazier.glb': glb(triangle().json, triangle().bin) } });
  const { json, bin } = triangle(),
    good = glb(json, bin);
  // A second JSON chunk: the loader would take the last one; the check took the first. Refused.
  const evil = Buffer.from(
    JSON.stringify({ ...json, buffers: [{ byteLength: 36, uri: 'https://evil.test/a.bin' }] }) +
      '    '.slice(
        0,
        (4 -
          (JSON.stringify({
            ...json,
            buffers: [{ byteLength: 36, uri: 'https://evil.test/a.bin' }],
          }).length %
            4)) %
          4,
      ),
  );
  const head = Buffer.alloc(8);
  head.writeUInt32LE(evil.length);
  head.writeUInt32LE(0x4e4f534a, 4);
  const twice = Buffer.concat([good, head, evil]);
  twice.writeUInt32LE(twice.length, 8);
  has(await glbProblems(twice), /chunks other than one JSON and one BIN/);
  // BIN first, JSON second.
  const jsonLength = good.readUInt32LE(12),
    jsonChunk = good.subarray(12, 20 + jsonLength),
    binChunk = good.subarray(20 + jsonLength);
  has(
    await glbProblems(Buffer.concat([good.subarray(0, 12), binChunk, jsonChunk])),
    /the first chunk is not JSON/,
  );
  // A chunk of another type.
  const other = Buffer.alloc(12);
  other.writeUInt32LE(4);
  other.writeUInt32LE(0x12345678, 4);
  const extra = Buffer.concat([good, other]);
  extra.writeUInt32LE(extra.length, 8);
  has(await glbProblems(extra), /chunks other than one JSON and one BIN/);
  // A chunk length not a multiple of 4, a header length that is not the file's, a JSON chunk that is not JSON.
  const odd = Buffer.from(good);
  odd.writeUInt32LE(jsonLength - 1, 12);
  has(await glbProblems(odd), /not aligned to 4 bytes|past the end/);
  const long = Buffer.from(good);
  long.writeUInt32LE(good.length + 4, 8);
  has(await glbProblems(long), /the header says/);
  const text = Buffer.from(good);
  text.fill(0x7b, 20, 24);
  has(await glbProblems(text), /JSON chunk is not JSON/);
});

test('GLB: nothing outside the file, only the allowed extensions wherever they stand', async () => {
  has(
    await glbProblems(
      broken((j) => {
        j.buffers[0].uri = 'data:application/octet-stream;base64,AAAA';
      }),
    ),
    /buffer 0 has a URI/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.buffers.push({ byteLength: 4, uri: 'b.bin' });
      }),
    ),
    /more than one buffer/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.buffers[0].byteLength = 4096;
      }),
    ),
    /buffer 0 is not inside the BIN chunk/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.images = [{ uri: 'https://evil.test/a.png' }];
      }),
    ),
    /image 0 has a URI/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.images = [{ bufferView: 0, mimeType: 'image/webp' }];
      }),
    ),
    /image 0 is image\/webp/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.images = [{ bufferView: 0, mimeType: 'image/png' }];
      }),
    ),
    /image 0 is not a readable PNG/,
  );
  // A texture plugin acts on a texture's extensions even when extensionsUsed does not name them.
  has(
    await glbProblems(
      broken((j) => {
        j.textures = [{ extensions: { EXT_texture_webp: { source: 0 } } }];
      }),
    ),
    /gltf.textures.0 uses EXT_texture_webp/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.materials = [{ extensions: { KHR_materials_transmission: {} } }];
      }),
    ),
    /uses KHR_materials_transmission/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.nodes[0].extensions = { EXT_mesh_gpu_instancing: { attributes: {} } };
      }),
    ),
    /uses EXT_mesh_gpu_instancing/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.extensionsRequired = ['KHR_draco_mesh_compression'];
      }),
    ),
    /uses KHR_draco_mesh_compression/,
  );
  // Extras are the author's own data, never read by the loader.
  await read({
    swap: {
      'models/brazier.glb': broken((j) => {
        j.extras = { extensions: { anything: 1 } };
      }),
    },
  });
  await read({
    swap: {
      'models/brazier.glb': broken((j) => {
        j.extensionsUsed = ['KHR_materials_unlit'];
        j.materials = [{ extensions: { KHR_materials_unlit: {} } }];
        j.meshes[0].primitives[0].material = 0;
      }),
    },
  });
});

test('GLB: one scene, every node in it once; accessors and views inside the data; still triangles only', async () => {
  has(
    await glbProblems(
      broken((j) => {
        j.scenes.push({ nodes: [] });
      }),
    ),
    /not exactly one scene/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.nodes.push({ mesh: 0 });
      }),
    ),
    /1 node\(s\) outside the scene/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.scenes[0].nodes = [0, 0];
      }),
    ),
    /node 0 is reached twice/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.nodes[0].children = [0];
      }),
    ),
    /node 0 is reached twice/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.nodes[0].mesh = 3;
      }),
    ),
    /names a mesh that does not exist/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.accessors[0].count = 4;
      }),
    ),
    /accessor 0 reads past its buffer view/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.accessors[0].byteOffset = 2;
      }),
    ),
    /accessor 0 reads past its buffer view/,
  );
  has(
    await glbProblems(
      broken((j) => {
        delete j.accessors[0].bufferView;
        j.accessors[0].count = 1e9;
      }),
    ),
    /accessor 0 has no buffer view/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.accessors[0].sparse = { count: 1 };
      }),
    ),
    /accessor 0 is sparse/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.accessors[0].componentType = 5130;
      }),
    ),
    /accessor 0 has no valid componentType/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.bufferViews[0].byteLength = 40;
      }),
    ),
    /bufferView 0 is not inside the BIN chunk/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.bufferViews[0].byteOffset = '8';
      }),
    ),
    /bufferView 0 is not inside the BIN chunk/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.meshes[0].primitives[0].mode = 1;
      }),
    ),
    /draws mode 1; format 1 takes triangles/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.meshes[0].primitives[0].targets = [{ POSITION: 0 }];
      }),
    ),
    /morph targets/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.meshes[0].primitives[0].indices = 7;
      }),
    ),
    /names indices that do not exist/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.skins = [{ joints: [0] }];
        j.nodes[0].skin = 0;
      }),
    ),
    /skins; format 1 models are still/,
  );
  has(
    await glbProblems(
      broken((j) => {
        j.textures = [{ source: 2 }];
      }),
    ),
    /texture 0 names no image/,
  );
  const png16 = png(16, 16, () => [1, 2, 3, 255]);
  const withImages = (n) => {
    const { json, bin } = triangle();
    const data = Buffer.concat([bin, png16, Buffer.alloc((4 - (png16.length % 4)) % 4)]);
    json.bufferViews.push({ buffer: 0, byteOffset: 36, byteLength: png16.length });
    json.buffers[0].byteLength = data.length;
    json.images = Array.from({ length: n }, () => ({ bufferView: 1, mimeType: 'image/png' }));
    return glb(json, data);
  };
  await read({ swap: { 'models/brazier.glb': withImages(2) } });
  has(await glbProblems(withImages(9)), /9 images, more than 8/);
  has(await glbProblems(withImages(1), { imageSize: 8 }), /image 0 is 16×16, more than 8×8/);
  has(
    await glbProblems(
      broken((j) => {
        j.images = [{ bufferView: 0, mimeType: 'image/jpeg' }];
      }),
    ),
    /image 0 is not a readable JPEG/,
  );
});

test("GLB: the check counts what the loader builds — triangles and nodes of the sample's model, loaded", async () => {
  const pack = await read(),
    assets = await loadPackAssets(pack, { signal: never });
  let triangles = 0,
    nodes = -1;
  assets.template('brazier').traverse((o) => {
    nodes++;
    if (o.isMesh) triangles += o.geometry.index.count / 3;
  });
  assets.release();
  assert.ok(triangles > 0);
  await read({}, { modelTriangles: triangles, modelNodes: nodes });
  has(
    await problems({}, { modelTriangles: triangles - 1 }),
    new RegExp(`${triangles} triangles, more than ${triangles - 1}`),
  );
  has(
    await problems({}, { modelNodes: nodes - 1 }),
    new RegExp(`${nodes} nodes, more than ${nodes - 1}`),
  );
});

test('structure.sides: "open" by default, "closed" for a cave; nothing else', async () => {
  assert.equal(
    (
      await read({
        edit: (j) => {
          delete j.structure.sides;
        },
      })
    ).structure.sides,
    'open',
  );
  assert.equal(
    (
      await read({
        edit: (j) => {
          j.structure.sides = 'closed';
        },
      })
    ).structure.sides,
    'closed',
  );
  has(
    await problems({
      edit: (j) => {
        j.structure.sides = 'ajar';
      },
    }),
    /pack.structure.sides: expected "open" or "closed"/,
  );
});

test('no crypto.subtle (a page over plain HTTP from another host): said plainly, before any file is read', async () => {
  const crypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto'),
    files = memoryFiles(sample);
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  try {
    await assert.rejects(
      readWorldPack(files, { signal: never }),
      /needs crypto.subtle.*secure context: serve the page over HTTPS or from localhost/,
    );
    assert.deepEqual(files.reads, [], 'nothing was fetched');
  } finally {
    Object.defineProperty(globalThis, 'crypto', crypto);
  }
});

test('limits are preliminary loader limits, set per call', async () => {
  has(await problems({}, { objects: 1 }), /pack.objects: more than 1 entries/);
  has(await problems({}, { size: [8, 8, 8] }), /structure.size\[0\]: expected a whole number 1..8/);
});

test("cancelled while reading: the signal's reason, not a PackError", async () => {
  const controller = new AbortController();
  const files = memoryFiles(sample, {
    gate: (path) => {
      if (path === 'structure.u16') controller.abort();
    },
  });
  await assert.rejects(
    readWorldPack(files, { signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
});

test("the core and the app never name a pack: no pack id of packs/ in src/ or packages/ but the app's catalog of them", async () => {
  const found = [],
    ids = await readdir(join(ROOT, 'packs'));
  assert.deepEqual(ids.sort(), ['color-calibration', 'sample-ruin']);
  // Source archives must be testable without a .git directory as well.
  for (const directory of ['src', 'packages']) {
    const entries = await readdir(join(ROOT, directory), { recursive: true, withFileTypes: true });
    for (const entry of entries)
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        // What the app offers, by folder; nothing of what is in a pack.
        if (path === join(ROOT, 'src', 'config', 'world-packs.ts')) continue;
        const text = await readFile(path, 'utf8');
        for (const id of ids) if (text.includes(id)) found.push(`${path}: ${id}`);
      }
  }
  assert.deepEqual(found, []);
});

test('the committed pack declares credits under a licence the repository takes (a statement, not proof)', async () => {
  const pack = await read();
  assert.ok(['CC0-1.0'].includes(pack.credits.license));
  assert.ok(pack.credits.authors.length > 0);
});
