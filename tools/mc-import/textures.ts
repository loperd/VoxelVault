import { crc32, deflateSync, inflateSync } from 'node:zlib';

/** RGBA pixels, rows from the top. */
export interface Image {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Any non-interlaced PNG a resource pack holds (grey, grey+alpha, RGB, RGBA at 8 bits; palette at
 * 1–8 bits, with tRNS) → RGBA. Offline, trusted input: the pack's own decoder (pack/png.ts) is the
 * strict one, and it reads what this tool writes.
 */
export function decodeImage(file: Uint8Array): Image {
  if (!SIGNATURE.every((b, i) => file[i] === b)) throw new Error('not a PNG');
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength),
    idat: Uint8Array[] = [];
  let width = 0,
    height = 0,
    depth = 0,
    type = 0,
    interlace = 0,
    palette: Uint8Array | undefined,
    trns: Uint8Array | undefined;
  for (let at = 8; at + 8 <= file.length;) {
    const length = view.getUint32(at),
      name = String.fromCharCode(...file.subarray(at + 4, at + 8)),
      body = file.subarray(at + 8, at + 8 + length);
    if (name === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = body[8]!;
      type = body[9]!;
      interlace = body[12]!;
    } else if (name === 'PLTE') palette = body;
    else if (name === 'tRNS') trns = body;
    else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    at += 12 + length;
  }
  if (!width || !height) throw new Error('no IHDR');
  if (interlace) throw new Error('interlaced');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels || (type === 3 ? ![1, 2, 4, 8].includes(depth) : depth !== 8))
    throw new Error(`colour type ${type} at ${depth} bits`);
  const raw = inflateSync(Buffer.concat(idat)),
    bits = channels * depth,
    stride = Math.ceil((width * bits) / 8),
    bpp = Math.max(1, bits / 8);
  if (raw.length !== height * (stride + 1)) throw new Error('image data of the wrong length');
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!,
      line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)),
      out = rows.subarray(y * stride, (y + 1) * stride);
    const up = y ? rows.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp]! : 0,
        b = up[i]!,
        c = i >= bpp ? up[i - bpp]! : 0;
      const p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][
        filter
      ];
      if (predictor === undefined) throw new Error(`filter ${filter}`);
      out[i] = (line[i]! + predictor) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4,
        row = y * stride;
      if (type === 3) {
        const index =
          (rows[row + ((x * depth) >> 3)]! >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1);
        if (!palette || 3 * index + 2 >= palette.length)
          throw new Error('palette index past the palette');
        rgba.set(
          [
            palette[3 * index]!,
            palette[3 * index + 1]!,
            palette[3 * index + 2]!,
            trns && index < trns.length ? trns[index]! : 255,
          ],
          o,
        );
      } else {
        const p = row + x * channels,
          g = rows[p]!;
        rgba.set(
          type === 0
            ? [g, g, g, 255]
            : type === 4
              ? [g, g, g, rows[p + 1]!]
              : type === 2
                ? [g, rows[p + 1]!, rows[p + 2]!, 255]
                : [g, rows[p + 1]!, rows[p + 2]!, rows[p + 3]!],
          o,
        );
      }
    }
  return { width, height, rgba };
}

/** RGBA → PNG (colour type 6, 8 bits, filter 0): the subset a world pack reads. */
export function encodeImage({ width, height, rgba }: Image): Uint8Array {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++)
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  const chunk = (name: string, body: Uint8Array) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length);
    head.write(name, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(SIGNATURE),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** The top `size`×`size` frame (an animated texture is a vertical strip of frames). */
export function firstFrame(image: Image, size: number): Image {
  return { width: size, height: size, rgba: image.rgba.slice(0, size * size * 4) };
}

/** Turned by `quarters`×90° clockwise. */
export function rotate(image: Image, quarters: number): Image {
  const q = ((quarters % 4) + 4) % 4,
    { width: w, height: h } = image;
  if (!q) return image;
  const width = q % 2 ? h : w,
    height = q % 2 ? w : h,
    rgba = new Uint8Array(image.rgba.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [nx, ny] = q === 1 ? [h - 1 - y, x] : q === 2 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
      rgba.set(image.rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (ny * width + nx) * 4);
    }
  return { width, height, rgba };
}

/** Multiplied by a colour, as the game tints grass and leaves by biome. */
export function tint(image: Image, hex: string): Image {
  const v = parseInt(hex.slice(1), 16),
    c = [(v >> 16) & 255, (v >> 8) & 255, v & 255],
    rgba = image.rgba.slice();
  for (let i = 0; i < rgba.length; i += 4)
    for (let k = 0; k < 3; k++) rgba[i + k] = Math.round((rgba[i + k]! * c[k]!) / 255);
  return { ...image, rgba };
}

/** Pixels neither clear nor solid: blockworld draws a cut-out (alpha test at .5), not a blend. */
export function translucent(image: Image): number {
  let n = 0;
  for (let i = 3; i < image.rgba.length; i += 4)
    if (image.rgba[i]! > 0 && image.rgba[i]! < 255) n++;
  return n;
}

/** Every pixel solid: a translucent material drawn opaque in its own colour. */
export function opaque(image: Image): Image {
  const rgba = image.rgba.slice();
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { ...image, rgba };
}
