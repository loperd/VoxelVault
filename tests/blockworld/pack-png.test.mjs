import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { decodePng } from '../../packages/blockworld/src/pack/png.ts';
import { CALIBRATION, packFolder, png } from './pack-fixture.mjs';

// The decoder's subset (png.ts): what it takes, byte for byte, and everything else refused by name.

const chunk = (name, body = Buffer.alloc(0)) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length);
  head.write(name, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
  return Buffer.concat([head, body, crc]);
};
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = ({
  size = 16,
  depth = 8,
  type = 6,
  compression = 0,
  filter = 0,
  interlace = 0,
} = {}) => {
  const body = Buffer.alloc(13);
  body.writeUInt32BE(size);
  body.writeUInt32BE(size, 4);
  body.set([depth, type, compression, filter, interlace], 8);
  return chunk('IHDR', body);
};
/** Rows of a 16×16 image of `channels` bytes a pixel, each row with filter byte `filter`. */
const rows = (channels, value = 7, filter = 0) => {
  const raw = Buffer.alloc(16 * (1 + 16 * channels), value);
  for (let y = 0; y < 16; y++) raw[y * (1 + 16 * channels)] = filter;
  return raw;
};
const file = (...chunks) => {
  const b = Buffer.concat([SIGNATURE, ...chunks]);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const rgba = (extra = []) =>
  file(ihdr(), ...extra, chunk('IDAT', deflateSync(rows(4))), chunk('IEND'));
const decode = (data, options = {}) => decodePng(data, { size: 16, ...options });

test('PNG: the calibration tiles and every colour type of the subset, exactly as painted', async () => {
  const tiles = await packFolder(CALIBRATION);
  const orange = await decode(tiles.get('textures/ref_orange.png'));
  assert.deepEqual([orange.width, orange.height], [16, 16]);
  assert.deepEqual([...orange.rgba.subarray(0, 4)], [0xc8, 0x64, 0x32, 255]);
  const rgb = await decode(
    new Uint8Array(png(16, 16, (x, y) => [x * 16, y * 16, 7], { type: 2 })).buffer,
  );
  assert.deepEqual(
    [...rgb.rgba.subarray((3 * 16 + 5) * 4, (3 * 16 + 5) * 4 + 4)],
    [80, 48, 7, 255],
  );
  // Grey with a transparent key; palette with alpha; grey+alpha. Every row filter (Sub, Up, Average, Paeth).
  const grey = await decode(
    file(
      ihdr({ type: 0 }),
      chunk('tRNS', Buffer.from([0, 7])),
      chunk('IDAT', deflateSync(rows(1, 7))),
      chunk('IEND'),
    ),
  );
  assert.deepEqual([...grey.rgba.subarray(0, 4)], [7, 7, 7, 0]);
  const palette = await decode(
    file(
      ihdr({ type: 3 }),
      chunk('PLTE', Buffer.from([10, 20, 30, 40, 50, 60])),
      chunk('tRNS', Buffer.from([255, 128])),
      chunk('IDAT', deflateSync(rows(1, 1))),
      chunk('IEND'),
    ),
  );
  assert.deepEqual([...palette.rgba.subarray(0, 4)], [40, 50, 60, 128]);
  const greyAlpha = await decode(
    file(ihdr({ type: 4 }), chunk('IDAT', deflateSync(rows(2, 9))), chunk('IEND')),
  );
  assert.deepEqual([...greyAlpha.rgba.subarray(0, 4)], [9, 9, 9, 9]);
  // Random pixels encoded with each row filter (PNG spec §9) come back exactly.
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
  const pixels = Buffer.from(Array.from({ length: 16 * 16 * 4 }, random)),
    stride = 64;
  for (const filter of [0, 1, 2, 3, 4]) {
    const raw = Buffer.alloc(16 * (stride + 1));
    for (let y = 0; y < 16; y++) {
      raw[y * (stride + 1)] = filter;
      for (let i = 0; i < stride; i++) {
        const at = y * stride + i,
          a = i >= 4 ? pixels[at - 4] : 0,
          u = y ? pixels[at - stride] : 0,
          c = y && i >= 4 ? pixels[at - stride - 4] : 0;
        const p = a + u - c,
          pa = Math.abs(p - a),
          pb = Math.abs(p - u),
          pc = Math.abs(p - c);
        raw[y * (stride + 1) + 1 + i] =
          (pixels[at] -
            [0, a, u, (a + u) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? u : c][filter]) &
          255;
      }
    }
    const out = await decode(file(ihdr(), chunk('IDAT', deflateSync(raw)), chunk('IEND')));
    assert.deepEqual(Buffer.from(out.rgba), pixels, `filter ${filter}`);
  }
  // Ancillary chunks are skipped: a tile is sRGB as painted, whatever gAMA or iCCP say.
  const tagged = await decode(
    rgba([
      chunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f])),
      chunk('sRGB', Buffer.from([0])),
      chunk('tEXt', Buffer.from('Comment\0x')),
    ]),
  );
  assert.deepEqual([...tagged.rgba.subarray(0, 4)], [7, 7, 7, 7]);
});

test('PNG: outside the subset is an error that says what it is', async () => {
  const refused = async (data, pattern) => assert.rejects(decode(data), pattern);
  await refused(file().slice(0, 4), /signature/);
  await refused(
    file(
      chunk('gAMA', Buffer.alloc(4)),
      ihdr(),
      chunk('IDAT', deflateSync(rows(4))),
      chunk('IEND'),
    ),
    /IHDR is not the first/,
  );
  await refused(
    file(ihdr(), ihdr(), chunk('IDAT', deflateSync(rows(4))), chunk('IEND')),
    /IHDR again/,
  );
  await refused(
    file(ihdr({ size: 32 }), chunk('IDAT', deflateSync(rows(4))), chunk('IEND')),
    /32×32; a tile is 16×16/,
  );
  await refused(
    file(ihdr({ depth: 16 }), chunk('IDAT', deflateSync(rows(8))), chunk('IEND')),
    /bit depth 16/,
  );
  await refused(
    file(ihdr({ type: 1 }), chunk('IDAT', deflateSync(rows(1))), chunk('IEND')),
    /colour type 1/,
  );
  await refused(
    file(ihdr({ compression: 1 }), chunk('IDAT', deflateSync(rows(4))), chunk('IEND')),
    /compression or filter method/,
  );
  await refused(
    file(ihdr({ filter: 1 }), chunk('IDAT', deflateSync(rows(4))), chunk('IEND')),
    /compression or filter method/,
  );
  await refused(
    file(ihdr({ interlace: 1 }), chunk('IDAT', deflateSync(rows(4))), chunk('IEND')),
    /interlaced/,
  );
  await refused(
    file(
      ihdr({ type: 0 }),
      chunk('PLTE', Buffer.alloc(3)),
      chunk('IDAT', deflateSync(rows(1))),
      chunk('IEND'),
    ),
    /palette in a grey image/,
  );
  await refused(
    file(
      ihdr({ type: 3 }),
      chunk('PLTE', Buffer.alloc(4)),
      chunk('IDAT', deflateSync(rows(1))),
      chunk('IEND'),
    ),
    /a palette of 4 bytes/,
  );
  await refused(
    file(ihdr({ type: 3 }), chunk('IDAT', deflateSync(rows(1))), chunk('IEND')),
    /without a palette/,
  );
  await refused(
    file(
      ihdr({ type: 3 }),
      chunk('PLTE', Buffer.alloc(3)),
      chunk('IDAT', deflateSync(rows(1, 5))),
      chunk('IEND'),
    ),
    /palette index 5 past the palette/,
  );
  await refused(rgba([chunk('tRNS', Buffer.alloc(2))]), /tRNS in an image with an alpha channel/);
  await refused(
    file(
      ihdr({ type: 2 }),
      chunk('tRNS', Buffer.alloc(2)),
      chunk('IDAT', deflateSync(rows(3))),
      chunk('IEND'),
    ),
    /tRNS of 2 bytes for colour type 2/,
  );
  await refused(
    file(
      ihdr({ type: 0 }),
      chunk('IDAT', deflateSync(rows(1))),
      chunk('tRNS', Buffer.alloc(2)),
      chunk('IEND'),
    ),
    /tRNS again, or after the image data/,
  );
  const data = deflateSync(rows(4)),
    half = data.length >> 1;
  await refused(
    file(
      ihdr(),
      chunk('IDAT', data.subarray(0, half)),
      chunk('tEXt', Buffer.from('a\0b')),
      chunk('IDAT', data.subarray(half)),
      chunk('IEND'),
    ),
    /split by another chunk/,
  );
  await refused(file(ihdr(), chunk('IDAT', data)), /no IEND/);
  await refused(file(ihdr(), chunk('IEND')), /no image data/);
  await refused(
    file(ihdr(), chunk('IDAT', data), chunk('IEND'), chunk('tEXt', Buffer.from('a\0b'))),
    /data after IEND/,
  );
  await refused(
    file(ihdr(), chunk('IDAT', data), chunk('IEND', Buffer.from([0]))),
    /IEND is not empty/,
  );
  await refused(rgba([chunk('ABCD', Buffer.alloc(1))]), /unknown critical chunk ABCD/);
  const crc = Buffer.from(rgba());
  crc[40] ^= 1;
  await refused(crc.buffer, /damaged \(CRC\)/);
  const cut = Buffer.from(rgba()).subarray(0, 50);
  await refused(cut.buffer.slice(cut.byteOffset, cut.byteOffset + cut.byteLength), /past the end/);
  const bad = Buffer.from(rows(4));
  bad[0] = 5;
  await refused(
    file(ihdr(), chunk('IDAT', deflateSync(bad)), chunk('IEND')),
    /unknown row filter 5/,
  );
});

test('PNG: the image data is read up to what the header promises, never further', async () => {
  // A compression bomb: 64 KiB of IDAT that would inflate to 64 MiB. Reading stops past 1 KiB + rows.
  const bomb = deflateSync(Buffer.alloc(64 << 20), { level: 9 });
  assert.ok(bomb.length < 70_000);
  await assert.rejects(
    decode(file(ihdr(), chunk('IDAT', bomb), chunk('IEND'))),
    /inflates past the 1040 bytes its header promises/,
  );
  await assert.rejects(
    decode(file(ihdr(), chunk('IDAT', deflateSync(rows(4).subarray(0, 600))), chunk('IEND'))),
    /600 bytes, expected 1040/,
  );
  await assert.rejects(
    decode(file(ihdr(), chunk('IDAT', Buffer.from('not zlib at all')), chunk('IEND'))),
    /does not inflate/,
  );
  const damaged = Buffer.from(deflateSync(rows(4)));
  damaged[damaged.length - 1] ^= 0xff; // the Adler-32 checksum
  await assert.rejects(
    decode(file(ihdr(), chunk('IDAT', damaged), chunk('IEND'))),
    /does not inflate|bytes/,
  );
});

test("PNG: cancelled, the decoding rejects with the signal's reason", async () => {
  const before = new AbortController();
  before.abort(new Error('switched away'));
  await assert.rejects(decode(rgba(), { signal: before.signal }), /switched away/);
  const during = new AbortController(),
    decoding = decode(
      file(ihdr(), chunk('IDAT', deflateSync(Buffer.alloc(64 << 20))), chunk('IEND')),
      { signal: during.signal },
    );
  during.abort(new Error('switched away'));
  await assert.rejects(decoding, /switched away|inflates past/);
});
