import { gunzipSync } from 'node:zlib';

/**
 * Sponge schematics (`.schem`, versions 1–3, as WorldEdit writes them): gzip'd NBT. Only what the
 * importer needs: size, palette, a palette index per cell, which cells hold block entities, and the
 * entities by kind. Nothing of the schematic is dropped without a count in the result.
 */
export interface Schematic {
  readonly version: number;
  /** The game's data version (3120 is 1.19.2), when the file says. */
  readonly dataVersion?: number;
  /** [x, y, z]: width, height, length. */
  readonly size: readonly [number, number, number];
  /** Block states as the file names them, e.g. `minecraft:spruce_stairs[facing=west,half=top]`. */
  readonly palette: readonly string[];
  /** A palette index per cell, x fastest, then z, then y (the file's own order). */
  readonly blocks: Uint32Array;
  /** Cells that hold a block entity (a barrel's inventory, a sign's text): cell index → its id. */
  readonly blockEntities: ReadonlyMap<number, string>;
  /** Block entities with no position, or one outside the schematic: counted, not placed. */
  readonly strayBlockEntities: number;
  /** Entities (mobs, item frames, armour stands), counted by id: none is imported. */
  readonly entities: ReadonlyMap<string, number>;
}

type Tag =
  | number
  | bigint
  | string
  | Tag[]
  | { [name: string]: Tag }
  | Int8Array
  | Int32Array
  | BigInt64Array;

/** Big-endian NBT, the named root compound's payload. */
export function readNbt(bytes: Uint8Array): Record<string, Tag> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    text = new TextDecoder();
  let at = 0;
  const need = (n: number) => {
    if (at + n > bytes.length) throw new Error('NBT: the file ends inside a tag.');
  };
  const count = () => {
    need(4);
    const n = view.getInt32(at);
    at += 4;
    if (n < 0 || n > bytes.length) throw new Error('NBT: a bad length.');
    return n;
  };
  const name = () => {
    need(2);
    const n = view.getUint16(at);
    at += 2;
    need(n);
    const s = text.decode(bytes.subarray(at, at + n));
    at += n;
    return s;
  };
  const payload = (type: number, depth: number): Tag => {
    if (depth > 64) throw new Error('NBT: nested too deep.');
    switch (type) {
      case 1:
        need(1);
        return view.getInt8(at++);
      case 2:
        need(2);
        at += 2;
        return view.getInt16(at - 2);
      case 3:
        need(4);
        at += 4;
        return view.getInt32(at - 4);
      case 4:
        need(8);
        at += 8;
        return view.getBigInt64(at - 8);
      case 5:
        need(4);
        at += 4;
        return view.getFloat32(at - 4);
      case 6:
        need(8);
        at += 8;
        return view.getFloat64(at - 8);
      case 7: {
        const n = count();
        need(n);
        const a = new Int8Array(bytes.slice(at, at + n).buffer);
        at += n;
        return a;
      }
      case 8:
        return name();
      case 9: {
        need(1);
        const t = bytes[at++]!,
          n = count(),
          list: Tag[] = [];
        for (let i = 0; i < n; i++) list.push(payload(t, depth + 1));
        return list;
      }
      case 10: {
        const out: Record<string, Tag> = {};
        for (;;) {
          need(1);
          const t = bytes[at++]!;
          if (t === 0) return out;
          out[name()] = payload(t, depth + 1);
        }
      }
      case 11: {
        const n = count();
        need(4 * n);
        const a = new Int32Array(n);
        for (let i = 0; i < n; i++) a[i] = view.getInt32(at + 4 * i);
        at += 4 * n;
        return a;
      }
      case 12: {
        const n = count();
        need(8 * n);
        const a = new BigInt64Array(n);
        for (let i = 0; i < n; i++) a[i] = view.getBigInt64(at + 8 * i);
        at += 8 * n;
        return a;
      }
      default:
        throw new Error(`NBT: unknown tag type ${type}.`);
    }
  };
  need(1);
  if (bytes[at++] !== 10) throw new Error('NBT: the root is not a compound.');
  name();
  return payload(10, 0) as Record<string, Tag>;
}

const object = (tag: Tag | undefined, what: string): Record<string, Tag> => {
  if (!tag || typeof tag !== 'object' || Array.isArray(tag) || ArrayBuffer.isView(tag))
    throw new Error(`Schematic: no ${what}.`);
  return tag as Record<string, Tag>;
};
const int = (tag: Tag | undefined, what: string): number => {
  if (typeof tag !== 'number' || !Number.isInteger(tag)) throw new Error(`Schematic: no ${what}.`);
  return tag;
};

export function readSchematic(file: Uint8Array): Schematic {
  const gz = file[0] === 0x1f && file[1] === 0x8b;
  let root = readNbt(gz ? new Uint8Array(gunzipSync(file, { maxOutputLength: 256 << 20 })) : file);
  // Version 3 wraps everything in "Schematic"; versions 1 and 2 are that compound at the root.
  if (root.Schematic) root = object(root.Schematic, 'Schematic compound');
  const version = int(root.Version, 'Version');
  if (version < 1 || version > 3)
    throw new Error(`Schematic: Sponge version ${version} is not supported (1–3).`);
  const blocksTag = version === 3 ? object(root.Blocks, 'Blocks') : root;
  const size = [
    int(root.Width, 'Width') & 0xffff,
    int(root.Height, 'Height') & 0xffff,
    int(root.Length, 'Length') & 0xffff,
  ] as const;
  // Indices are unique and need not be dense (the spec does not ask it); a cell naming a gap is refused below.
  const paletteTag = object(blocksTag.Palette, 'Palette'),
    palette: string[] = [];
  for (const [state, index] of Object.entries(paletteTag)) {
    const i = int(index, `palette index of ${state}`);
    if (i < 0 || palette[i] !== undefined) throw new Error(`Schematic: a bad palette index ${i}.`);
    palette[i] = state;
  }
  const data = version === 3 ? blocksTag.Data : root.BlockData;
  if (!(data instanceof Int8Array)) throw new Error('Schematic: no block data.');
  // Palette indices as unsigned LEB128 varints, one per cell: at least a byte each, checked before the cells are allocated.
  const cells = size[0] * size[1] * size[2];
  if (cells > data.length)
    throw new Error(
      `Schematic: ${size.join('×')} cells, but block data for at most ${data.length}.`,
    );
  const blocks = new Uint32Array(cells);
  let at = 0;
  for (let i = 0; i < cells; i++) {
    let value = 0,
      shift = 0,
      byte: number;
    do {
      if (at >= data.length) throw new Error('Schematic: the block data ends early.');
      byte = data[at++]! & 0xff;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (shift > 28) throw new Error('Schematic: a varint too long.');
    } while (byte & 0x80);
    if (palette[value] === undefined)
      throw new Error(
        `Schematic: palette index ${value} ${value >= palette.length ? 'past the palette' : 'names no state'}.`,
      );
    blocks[i] = value;
  }
  if (at !== data.length) throw new Error('Schematic: block data longer than the schematic.');
  const blockEntities = new Map<number, string>();
  let strayBlockEntities = 0;
  // v1 names them TileEntities, v2 BlockEntities at the root, v3 BlockEntities under Blocks.
  for (const entity of (blocksTag.BlockEntities ?? root.TileEntities ?? []) as Tag[]) {
    const e = object(entity, 'block entity'),
      pos = e.Pos;
    if (!(pos instanceof Int32Array) || pos.length !== 3) {
      strayBlockEntities++;
      continue;
    }
    const [x, y, z] = pos as unknown as [number, number, number];
    if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2]) {
      strayBlockEntities++;
      continue;
    }
    blockEntities.set(
      x + size[0] * (z + size[2] * y),
      String(e.Id ?? 'unknown').replace(/^minecraft:/, ''),
    );
  }
  const entities = new Map<string, number>();
  for (const entity of (root.Entities ?? []) as Tag[]) {
    const id = String(object(entity, 'entity').Id ?? 'unknown').replace(/^minecraft:/, '');
    entities.set(id, (entities.get(id) ?? 0) + 1);
  }
  return {
    version,
    ...(typeof root.DataVersion === 'number' ? { dataVersion: root.DataVersion } : {}),
    size,
    palette,
    blocks,
    blockEntities,
    strayBlockEntities,
    entities,
  };
}

/** The part of a schematic within [from, to] (cells, inclusive): a building cut out of its terrain or case. */
export function cropSchematic(
  s: Schematic,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
): Schematic {
  if (from.some((v, i) => !Number.isInteger(v) || v < 0 || v > to[i]! || to[i]! >= s.size[i]!))
    throw new Error(`Region ${from.join(',')}:${to.join(',')} is not inside ${s.size.join('×')}.`);
  const size = [to[0] - from[0] + 1, to[1] - from[1] + 1, to[2] - from[2] + 1] as const,
    [sx, , sz] = s.size;
  const blocks = new Uint32Array(size[0] * size[1] * size[2]),
    blockEntities = new Map<number, string>();
  let strayBlockEntities = s.strayBlockEntities;
  for (let y = 0; y < size[1]; y++)
    for (let z = 0; z < size[2]; z++)
      for (let x = 0; x < size[0]; x++) {
        const source = x + from[0] + sx * (z + from[2] + sz * (y + from[1])),
          i = x + size[0] * (z + size[2] * y);
        blocks[i] = s.blocks[source]!;
        const entity = s.blockEntities.get(source);
        if (entity) blockEntities.set(i, entity);
      }
  // Those outside the region are left out with it: counted in the region's cells (import.ts), not as strays.
  return { ...s, size, blocks, blockEntities, strayBlockEntities };
}
