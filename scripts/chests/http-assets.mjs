/** Static review server with verified lossless HTTP compression. No npm deps.
 * Import createAssetHandler for socket-free tests; CLI: node serve.mjs [root] [port].
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  brotliCompressSync,
  brotliDecompressSync,
  gzipSync,
  gunzipSync,
  constants,
} from 'node:zlib';

export function compress(raw, coding) {
  if (!['br', 'gzip'].includes(coding)) throw new RangeError('Unsupported content coding');
  const encoded =
    coding === 'br'
      ? brotliCompressSync(raw, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 11,
            [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        })
      : gzipSync(raw, { level: 9 });
  const decoded = coding === 'br' ? brotliDecompressSync(encoded) : gunzipSync(encoded);
  if (!decoded.equals(raw)) throw new Error('Compression roundtrip mismatch');
  return encoded;
}
function negotiation(value) {
  const entries = new Map(
    value
      .toLowerCase()
      .split(',')
      .filter(Boolean)
      .map((entry) => {
        const [name, ...options] = entry.trim().split(';');
        const option = options.find((v) => v.trim().startsWith('q='));
        const quality = option ? Number(option.trim().slice(2)) : 1;
        return [
          name.trim(),
          Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0,
        ];
      }),
  );
  const identity = entries.get('identity') ?? (entries.get('*') === 0 ? 0 : 1);
  const encodings = ['br', 'gzip']
    .map((name) => ({ name, q: entries.get(name) ?? entries.get('*') ?? 0 }))
    .filter((e) => e.q > 0 && (!entries.has('identity') || e.q >= identity))
    .sort((a, b) => b.q - a.q);
  return { identity, encodings };
}
const mime = {
  '.glb': 'model/gltf-binary',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.css': 'text/css',
};
export function createAssetHandler(directory) {
  const root = resolve(directory),
    cache = new Map();
  return async (request) => {
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response(null, { status: 400 });
    }
    const path = resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
    if (!path.startsWith(root + sep)) return new Response(null, { status: 403 });
    let info;
    try {
      info = await stat(path);
      if (!info.isFile()) return new Response(null, { status: 404 });
    } catch {
      return new Response(null, { status: 404 });
    }
    const key = `${info.mtimeMs}:${info.size}`;
    if (cache.get(path)?.key !== key)
      cache.set(path, { key, asset: readFile(path).then((raw) => ({ raw, variants: new Map() })) });
    const asset = await cache.get(path).asset,
      accepted = negotiation(request.headers.get('accept-encoding') ?? '');
    let coding = 'identity',
      body = asset.raw;
    for (const choice of accepted.encodings) {
      if (!asset.variants.has(choice.name))
        asset.variants.set(
          choice.name,
          (async () => {
            try {
              const encoded = await readFile(path + (choice.name === 'br' ? '.br' : '.gz'));
              const decoded =
                choice.name === 'br' ? brotliDecompressSync(encoded) : gunzipSync(encoded);
              if (decoded.equals(asset.raw)) return encoded;
            } catch {
              /* No valid sidecar: compute once, cache for subsequent requests. */
            }
            return compress(asset.raw, choice.name);
          })(),
        );
      const encoded = await asset.variants.get(choice.name);
      if (encoded.length < asset.raw.length || accepted.identity === 0) {
        coding = choice.name;
        body = encoded;
        break;
      }
    }
    if (coding === 'identity' && accepted.identity === 0)
      return new Response(null, { status: 406, headers: { Vary: 'Accept-Encoding' } });
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
    const headers = new Headers({
      'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
      Vary: 'Accept-Encoding',
      ETag: etag,
      'Cache-Control': 'public, max-age=0, must-revalidate',
    });
    if (coding !== 'identity') headers.set('Content-Encoding', coding);
    if (
      (request.headers.get('if-none-match') ?? '')
        .split(',')
        .some((tag) => tag.trim().replace(/^W\//, '') === etag || tag.trim() === '*')
    )
      return new Response(null, { status: 304, headers });
    headers.set('Content-Length', String(body.length));
    return new Response(request.method === 'HEAD' ? null : body, { headers });
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? fileURLToPath(new URL('./', import.meta.url)),
    port = Number(process.argv[3] ?? 4186),
    handler = createAssetHandler(root);
  const server = createServer(async (req, res) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const response = await handler(
        new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(error);
      res.writeHead(500);
      res.end();
    }
  });
  server.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/relic-review.html`));
}
