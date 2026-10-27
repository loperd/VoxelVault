/**
 * A pack's PNG tiles to RGBA pixels, with no DOM and no canvas: the same code in Node and in a
 * browser (DecompressionStream is in both), so what a test decodes is what the page shows, byte for
 * byte — no colour management, no premultiplied alpha, as a browser's image decoding would bring.
 *
 * The subset of format 1, and nothing else (PNG spec, 3rd ed.):
 * - the signature, then IHDR first: exactly the size asked for, bit depth 8, colour type grey (0),
 *   RGB (2), palette (3), grey+alpha (4) or RGBA (6), compression 0, filter method 0, not interlaced;
 * - PLTE (1..256 entries) before the image data, required for a palette image, refused for grey;
 * - tRNS before the image data, of the length its colour type has, never with an alpha channel;
 * - IDAT chunks one after another, inflating to exactly the bytes the header promises (decoding
 *   stops at that, so a small file cannot expand into a large one), row filters 0..4;
 * - IEND, empty and last;
 * - ancillary chunks (gAMA, iCCP, sRGB, tEXt…) are skipped: a tile's bytes are sRGB as painted, the
 *   way the blocks show them. An unknown critical chunk, a bad CRC, a broken stream are errors.
 */
export async function decodePng(
  data: ArrayBuffer,
  options: { readonly size: number; readonly signal?: AbortSignal },
): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  const b = new Uint8Array(data),
    view = new DataView(data),
    fail = (message: string): never => {
      throw new Error(`PNG: ${message}`);
    };
  if (b.length < 8 || SIGNATURE.some((v, i) => b[i] !== v)) fail('not a PNG (signature).');
  let width = 0,
    height = 0,
    type = -1,
    palette: Uint8Array | undefined,
    alpha: Uint8Array | undefined,
    ended = false,
    idatDone = false;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < b.length;) {
    if (ended) fail('data after IEND.');
    if (at + 12 > b.length) fail('a chunk past the end.');
    const length = view.getUint32(at),
      name = String.fromCharCode(...b.subarray(at + 4, at + 8));
    if (!/^[A-Za-z]{4}$/.test(name)) fail('a chunk without a name.');
    if (length > b.length - at - 12) fail(`chunk ${name} past the end.`);
    const body = b.subarray(at + 8, at + 8 + length);
    if (crc(b.subarray(at + 4, at + 8 + length)) !== view.getUint32(at + 8 + length))
      fail(`chunk ${name} is damaged (CRC).`);
    if (at === 8 && name !== 'IHDR') fail('IHDR is not the first chunk.');
    if (idat.length && name !== 'IDAT') idatDone = true;
    switch (name) {
      case 'IHDR': {
        if (at !== 8 || length !== 13) fail('IHDR again, or of the wrong length.');
        width = view.getUint32(at + 8);
        height = view.getUint32(at + 12);
        type = b[at + 17]!;
        if (width !== options.size || height !== options.size)
          fail(`${width}×${height}; a tile is ${options.size}×${options.size}.`);
        if (b[at + 16] !== 8 || !(type in CHANNELS))
          fail(
            `bit depth ${b[at + 16]}, colour type ${type}; format 1 takes 8-bit grey, RGB, palette, grey+alpha or RGBA.`,
          );
        if (b[at + 18] !== 0 || b[at + 19] !== 0) fail('an unknown compression or filter method.');
        if (b[at + 20] !== 0) fail('interlaced; format 1 takes non-interlaced PNG.');
        break;
      }
      case 'PLTE':
        if (palette || idat.length || alpha) fail('PLTE again, or after tRNS or the image data.');
        if (type === 0 || type === 4) fail('a palette in a grey image.');
        if (length === 0 || length % 3 || length > 768) fail(`a palette of ${length} bytes.`);
        palette = body.slice();
        break;
      case 'tRNS':
        if (alpha || idat.length) fail('tRNS again, or after the image data.');
        if (type === 4 || type === 6) fail('tRNS in an image with an alpha channel.');
        if (type === 3 && (!palette || length > palette.length / 3))
          fail('tRNS before the palette or longer than it.');
        if ((type === 0 && length !== 2) || (type === 2 && length !== 6))
          fail(`tRNS of ${length} bytes for colour type ${type}.`);
        alpha = body.slice();
        break;
      case 'IDAT':
        if (idatDone) fail('the image data is split by another chunk.');
        idat.push(body);
        break;
      case 'IEND':
        if (length !== 0) fail('IEND is not empty.');
        ended = true;
        break;
      default:
        // Upper case first: critical, a decoder must know it. Lower case: ancillary, safe to skip.
        if (name.charCodeAt(0) < 97) fail(`an unknown critical chunk ${name}.`);
    }
    at += 12 + length;
  }
  if (!ended) fail('no IEND.');
  if (!idat.length) fail('no image data.');
  if (type === 3 && !palette) fail('a palette image without a palette.');
  const channels = CHANNELS[type]!,
    stride = width * channels,
    expected = height * (stride + 1);
  const raw = await inflate(idat, expected, options.signal);

  // Undo the per-row filters (PNG spec §9).
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!,
      row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride),
      up = y ? pixels.subarray((y - 1) * stride, y * stride) : undefined;
    if (filter > 4) fail(`unknown row filter ${filter}.`);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels]! : 0,
        c = up && i >= channels ? up[i - channels]! : 0,
        u = up ? up[i]! : 0;
      const p = a + u - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - u),
        pc = Math.abs(p - c);
      const predicted = [0, a, u, (a + u) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? u : c][
        filter
      ]!;
      out[i] = (row[i]! + predicted) & 255;
    }
  }

  const rgba = new Uint8Array(width * height * 4),
    p = pixels;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    switch (type) {
      case 0:
        rgba[o] = rgba[o + 1] = rgba[o + 2] = p[i]!;
        rgba[o + 3] = alpha && ((alpha[0]! << 8) | alpha[1]!) === p[i] ? 0 : 255;
        break;
      case 2: {
        rgba[o] = p[i * 3]!;
        rgba[o + 1] = p[i * 3 + 1]!;
        rgba[o + 2] = p[i * 3 + 2]!;
        rgba[o + 3] =
          alpha &&
          alpha[1] === p[i * 3] &&
          alpha[3] === p[i * 3 + 1] &&
          alpha[5] === p[i * 3 + 2] &&
          !alpha[0] &&
          !alpha[2] &&
          !alpha[4]
            ? 0
            : 255;
        break;
      }
      case 3: {
        const index = p[i]!;
        if (index * 3 + 2 >= palette!.length) fail(`palette index ${index} past the palette.`);
        rgba[o] = palette![index * 3]!;
        rgba[o + 1] = palette![index * 3 + 1]!;
        rgba[o + 2] = palette![index * 3 + 2]!;
        rgba[o + 3] = alpha?.[index] ?? 255;
        break;
      }
      case 4:
        rgba[o] = rgba[o + 1] = rgba[o + 2] = p[i * 2]!;
        rgba[o + 3] = p[i * 2 + 1]!;
        break;
      default:
        rgba.set(p.subarray(o, o + 4), o);
    }
  }
  return { width, height, rgba };
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * The zlib stream of the image data, read up to `expected` bytes: one byte more and the stream is
 * cancelled (more data than the header promises), one less is an error too. Cancelled by `signal`.
 */
async function inflate(
  parts: readonly Uint8Array[],
  expected: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = new Blob(parts as unknown as BlobPart[])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
    .getReader();
  const out = new Uint8Array(expected),
    onAbort = () => {
      void reader.cancel().catch(() => {});
    };
  signal?.addEventListener('abort', onAbort, { once: true });
  let length = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(
          `PNG: the image data does not inflate (${error instanceof Error ? error.message : String(error)}).`,
          { cause: error },
        );
      }
      signal?.throwIfAborted();
      if (chunk.done) break;
      if (length + chunk.value.length > expected)
        throw new Error(
          `PNG: the image data inflates past the ${expected} bytes its header promises.`,
        );
      out.set(chunk.value, length);
      length += chunk.value.length;
    }
    if (length !== expected)
      throw new Error(`PNG: the image data is ${length} bytes, expected ${expected}.`);
    return out;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Whatever stopped the reading, the stream and its decompressor are let go.
    await reader.cancel().catch(() => {});
  }
}

let table: Uint32Array | undefined;
function crc(bytes: Uint8Array): number {
  table ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const v of bytes) c = table[(c ^ v) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
