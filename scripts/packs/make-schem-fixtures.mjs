/**
 * Sponge schematics v1, v2 and v3 for tests/blockworld/mc-import.test.mjs, written by an NBT library
 * that is not ours (prismarine-nbt), so the importer's reader (tools/mc-import/schem.ts) is checked
 * against files it did not write. Beside them, expected.json: what each file holds, from the same
 * inputs. Not part of the build; prismarine-nbt is not a dependency of the project.
 *
 *   npm i --prefix "$TMPDIR/nbt" prismarine-nbt@2.8.0
 *   node scripts/packs/make-schem-fixtures.mjs "$TMPDIR/nbt/node_modules/prismarine-nbt"
 *
 * Layout as the spec has it (github.com/SpongePowered/Schematic-Specification, versions 1–3):
 * v1 Palette/BlockData/TileEntities at the root, no DataVersion; v2 adds DataVersion, BlockEntities,
 * Entities; v3 wraps everything in "Schematic" and moves blocks under Blocks { Palette, Data, BlockEntities }.
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const [library] = process.argv.slice(2);
if (!library) {
  console.error('usage: make-schem-fixtures.mjs <path to prismarine-nbt>');
  process.exit(2);
}
const nbt = createRequire(import.meta.url)(library);
const OUT = new URL('../../tests/blockworld/fixtures/sponge/', import.meta.url);

// 6 × 4 × 6 = 144 cells, 140 states: indices past 127 take two varint bytes.
const size = [6, 4, 6],
  cells = size[0] * size[1] * size[2];
const states = [
  'minecraft:air',
  'minecraft:stone',
  'minecraft:spruce_leaves[distance=7,persistent=true,waterlogged=false]',
  'minecraft:oak_stairs[facing=east,half=top,shape=outer_left,waterlogged=false]',
  'minecraft:barrel[facing=up,open=false]',
  'create:shaft[axis=y]',
  ...Array.from({ length: 134 }, (_, i) => `minecraft:test_block_${i}`),
];
// Palette order is not cell order: indices are a permutation, as real files have them.
const order = states.map((_, i) => i).sort((a, b) => ((a * 37) % 140) - ((b * 37) % 140));
const indexOf = new Map(order.map((state, index) => [states[state], index]));
const stateAt = (i) => states[i < states.length ? i : i % 6];
const indices = Array.from({ length: cells }, (_, i) => indexOf.get(stateAt(i)));
const varints = (values) =>
  values.flatMap((v) => {
    const out = [];
    do {
      out.push((((v & 0x7f) | (v > 0x7f ? 0x80 : 0)) << 24) >> 24);
      v >>>= 7;
    } while (v);
    return out;
  });
const palette = nbt.comp(Object.fromEntries([...indexOf].map(([s, i]) => [s, nbt.int(i)])));
const barrel = states.indexOf('minecraft:barrel[facing=up,open=false]'),
  at = (i) => [i % size[0], Math.floor(i / (size[0] * size[2])), Math.floor(i / size[0]) % size[2]];
const be = (version) =>
  nbt.list(
    nbt.comp([
      {
        Id: nbt.string('minecraft:barrel'),
        Pos: nbt.intArray(at(barrel)),
        ...(version === 3
          ? { Data: nbt.comp({ Items: nbt.list(nbt.comp([])) }) }
          : { Items: nbt.list(nbt.comp([])) }),
      },
      // Outside the schematic: the reader must count it, not drop it unseen.
      { Id: nbt.string('minecraft:chest'), Pos: nbt.intArray([size[0], 0, 0]) },
    ]),
  );
const entities = nbt.list(
  nbt.comp([
    { Id: nbt.string('minecraft:armor_stand'), Pos: nbt.list(nbt.double([1.5, 1, 1.5])) },
    { Id: nbt.string('minecraft:armor_stand'), Pos: nbt.list(nbt.double([2.5, 1, 1.5])) },
    { Id: nbt.string('minecraft:item_frame'), Pos: nbt.list(nbt.double([0.5, 2, 0.5])) },
  ]),
);
const dims = {
  Width: nbt.short(size[0]),
  Height: nbt.short(size[1]),
  Length: nbt.short(size[2]),
  Offset: nbt.intArray([-3, 0, -3]),
};
const files = {
  'v1.schem': {
    name: 'Schematic',
    value: {
      Version: nbt.int(1),
      ...dims,
      Metadata: nbt.comp({ Name: nbt.string('v1 fixture') }),
      PaletteMax: nbt.int(states.length),
      Palette: palette,
      BlockData: nbt.byteArray(varints(indices)),
      TileEntities: be(1),
    },
  },
  'v2.schem': {
    name: 'Schematic',
    value: {
      Version: nbt.int(2),
      DataVersion: nbt.int(3120),
      ...dims,
      PaletteMax: nbt.int(states.length),
      Palette: palette,
      BlockData: nbt.byteArray(varints(indices)),
      BlockEntities: be(2),
      Entities: entities,
    },
  },
  'v3.schem': {
    name: '',
    value: {
      Schematic: nbt.comp({
        Version: nbt.int(3),
        DataVersion: nbt.int(3465),
        ...dims,
        Metadata: nbt.comp({ Date: nbt.long([0, 1]) }),
        Blocks: nbt.comp({
          Palette: palette,
          Data: nbt.byteArray(varints(indices)),
          BlockEntities: be(3),
        }),
        Biomes: nbt.comp({
          Palette: nbt.comp({ 'minecraft:plains': nbt.int(0) }),
          Data: nbt.byteArray(Array(cells).fill(0)),
        }),
        Entities: entities,
      }),
    },
  },
};
await mkdir(OUT, { recursive: true });
for (const [name, { name: rootName, value }] of Object.entries(files)) {
  await writeFile(
    new URL(name, OUT),
    gzipSync(nbt.writeUncompressed({ type: 'compound', name: rootName, value })),
  );
}
const expected = {
  size,
  palette: Object.fromEntries(indexOf),
  cells: indices,
  blockEntities: { inside: [[at(barrel), 'barrel']], outside: 1 },
  entities: {
    v1: {},
    v2: { armor_stand: 2, item_frame: 1 },
    v3: { armor_stand: 2, item_frame: 1 },
  },
  dataVersion: { v1: null, v2: 3120, v3: 3465 },
};
await writeFile(new URL('expected.json', OUT), `${JSON.stringify(expected)}\n`);
console.log(`${Object.keys(files).join(', ')} and expected.json → ${OUT.pathname}`);
