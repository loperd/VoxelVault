import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

export const SAMPLE = join(import.meta.dirname, '..', '..', 'packs', 'sample-ruin');
export const CALIBRATION = join(import.meta.dirname, '..', '..', 'packs', 'color-calibration');

/** Every file of a pack folder, by its path inside the pack. */
export async function packFolder(dir = SAMPLE) {
  const files = new Map();
  const walk = async (at) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const b = await readFile(path);
        files.set(
          relative(dir, path).split('\\').join('/'),
          b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
        );
      }
    }
  };
  await walk(dir);
  return files;
}

/**
 * PackFiles over a map, with pack.json changed by `edit` and files replaced by `swap` (undefined
 * removes one). `gate(path)` may return a promise a read waits for (to hold a step back).
 */
export function memoryFiles(files, { edit, swap = {}, gate } = {}) {
  const map = new Map(files);
  if (edit) {
    const json = JSON.parse(new TextDecoder().decode(map.get('pack.json')));
    edit(json);
    map.set('pack.json', new TextEncoder().encode(JSON.stringify(json)).buffer);
  }
  for (const [path, data] of Object.entries(swap))
    data === undefined
      ? map.delete(path)
      : map.set(path, data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer);
  const reads = [];
  const read = async (path, signal) => {
    reads.push(path);
    if (gate) await gate(path, signal);
    signal.throwIfAborted();
    const data = map.get(path);
    if (!data) throw new Error('no such file');
    return data;
  };
  read.reads = reads;
  return read;
}

/** A PNG of w×h RGBA pixels from `pixel(x, y)`; `damage` breaks its image data (CRC kept right). */
export function png(w, h, pixel, { type = 6, damage = false } = {}) {
  const channels = type === 6 ? 4 : 3,
    raw = Buffer.alloc(h * (1 + w * channels));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      raw.set(pixel(x, y).slice(0, channels), y * (1 + w * channels) + 1 + x * channels);
  let data = deflateSync(raw);
  if (damage) {
    data = Buffer.from(data);
    data[Math.floor(data.length / 2)] ^= 0xff;
    data = data.subarray(0, data.length - 3);
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
  ihdr.writeUInt32BE(w);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, type, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', data),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A GLB from a glTF JSON and a BIN chunk. */
export function glb(json, bin = Buffer.alloc(0)) {
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  bin = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const header = Buffer.alloc(12),
    jh = Buffer.alloc(8),
    bh = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + (bin.length ? 8 + bin.length : 0), 8);
  jh.writeUInt32LE(text.length);
  jh.writeUInt32LE(0x4e4f534a, 4);
  bh.writeUInt32LE(bin.length);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, text, ...(bin.length ? [bh, bin] : [])]);
}

/** One triangle mesh on `nodes` nodes (a mesh used many times), as a GLB. */
export function triangleGlb({ nodes = 1, count = 3, extensions, uri } = {}) {
  const bin = Buffer.alloc(count * 12);
  for (let i = 0; i < count; i++)
    (bin.writeFloatLE(i % 3 === 1 ? 1 : 0, i * 12),
      bin.writeFloatLE(i % 3 === 2 ? 1 : 0, i * 12 + 4));
  return glb(
    {
      asset: { version: '2.0' },
      ...(extensions ? { extensionsUsed: extensions } : {}),
      scene: 0,
      scenes: [{ nodes: Array.from({ length: nodes }, (_, i) => i) }],
      nodes: Array.from({ length: nodes }, () => ({ mesh: 0 })),
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
      buffers: [{ byteLength: bin.length, ...(uri ? { uri } : {}) }],
    },
    bin,
  );
}

export const never = new AbortController().signal;

/**
 * A page for BlockView in Node: a document whose canvases give a stand-in WebGL2 context (every call
 * answers, nothing is drawn), so three's real WebGLRenderer runs — its programs, its info counters —
 * and a view's life (stages, passes, disposal) is tested as the browser runs it. `restore()` undoes it.
 */
export function fakePage() {
  const previous = globalThis.document,
    document = {
      createElementNS: () => fakeCanvas(document),
      addEventListener() {},
      removeEventListener() {},
      visibilityState: 'visible',
    };
  globalThis.document = document;
  document.defaultView = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    devicePixelRatio: 1,
    performance,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  };
  const element = () => {
    const host = {
      ownerDocument: document,
      getBoundingClientRect: () => ({ width: 320, height: 180 }),
      prepend(canvas) {
        canvas.parentElement = host;
      },
    };
    return host;
  };
  return {
    document,
    element,
    restore: () => {
      globalThis.document = previous;
    },
  };
}

function fakeCanvas(document) {
  const constants = new Map(),
    names = new Map(),
    params = {
      VERSION: 'WebGL 2.0',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 3.00',
      VENDOR: 'fake',
      RENDERER: 'fake',
    };
  const nothing = new Proxy(
    {},
    {
      get: (_, name) =>
        typeof name === 'string' && /^[A-Z0-9_]+$/.test(name) ? 1 : () => undefined,
    },
  );
  const gl = new Proxy(
    {
      getContextAttributes: () => ({
        alpha: false,
        antialias: false,
        depth: true,
        stencil: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        powerPreference: 'low-power',
      }),
      getParameter: (p) => {
        const name = names.get(p);
        return name in params
          ? params[name]
          : name === 'VIEWPORT' || name === 'SCISSOR_BOX'
            ? new Int32Array([0, 0, 1, 1])
            : 16;
      },
      getExtension: () => nothing,
      getSupportedExtensions: () => [],
      getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
      getShaderParameter: () => true,
      getProgramParameter: (_, p) => (names.get(p)?.startsWith('ACTIVE_') ? 0 : true),
      getShaderInfoLog: () => '',
      getProgramInfoLog: () => '',
      getShaderSource: () => '',
      getUniformLocation: () => null,
      getAttribLocation: () => -1,
      isContextLost: () => false,
      checkFramebufferStatus: () => gl.FRAMEBUFFER_COMPLETE,
    },
    {
      get(target, name) {
        if (name in target) return target[name];
        if (typeof name !== 'string') return undefined;
        if (/^[A-Z0-9_]+$/.test(name)) {
          if (!constants.has(name)) {
            constants.set(name, constants.size + 1);
            names.set(constants.size, name);
          }
          return constants.get(name);
        }
        return () => ({});
      },
    },
  );
  const canvas = {
    width: 1,
    height: 1,
    style: {},
    ownerDocument: document,
    getContext: () => gl,
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    remove() {
      canvas.parentElement = undefined;
    },
    toDataURL: () => 'data:,',
  };
  gl.canvas = canvas;
  return canvas;
}
