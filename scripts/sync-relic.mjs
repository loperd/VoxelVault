import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

const source = new URL('../assets/chests/relic-v4-runtime/relic.glb', import.meta.url);
const target = new URL('../public/models/relic-v4-8dc4b45a.glb', import.meta.url);
const bytes = await readFile(source);
const sha = createHash('sha256').update(bytes).digest('hex');
if (sha !== '8dc4b45a8d330410d157c169b5bbfb61d6c17804f0edfd5374350a8ceefc6d20') {
  throw new Error(
    'Relic release changed: review it and update the content-versioned path and hash together.',
  );
}
await mkdir(new URL('../public/models/', import.meta.url), { recursive: true });
await writeFile(target, bytes);
for (const [suffix, decode] of [
  ['.br', brotliDecompressSync],
  ['.gz', gunzipSync],
]) {
  const packed = await readFile(new URL(source.href + suffix));
  if (!decode(packed).equals(bytes))
    throw new Error(`Relic ${suffix} sidecar does not match the GLB.`);
  await writeFile(new URL(target.href + suffix), packed);
}
console.log(`Relic runtime synchronized (${bytes.length} bytes; checked Brotli/gzip sidecars).`);
