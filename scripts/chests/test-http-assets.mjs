import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createAssetHandler, compress } from './http-assets.mjs';

test('GLB HTTP representations preserve bytes, negotiate, cache and handle HEAD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relic-http-'));
  try {
    const raw = await readFile(
      new URL('../../assets/chests/relic-v4-runtime/relic.glb', import.meta.url),
    );
    await writeFile(join(root, 'relic.glb'), raw);
    await writeFile(join(root, 'relic.glb.br'), compress(raw, 'br'));
    const handler = createAssetHandler(root),
      request = (headers = {}, method = 'GET') =>
        handler(new Request('http://review.test/relic.glb', { headers, method }));
    for (const coding of ['br', 'gzip', 'identity']) {
      const result = await request({ 'Accept-Encoding': coding });
      assert.equal(result.status, 200);
      assert.equal(result.headers.get('Vary'), 'Accept-Encoding');
      assert.equal(result.headers.get('Content-Type'), 'model/gltf-binary');
      const body = Buffer.from(await result.arrayBuffer());
      assert.equal(Number(result.headers.get('Content-Length')), body.length);
      assert.equal(result.headers.get('Content-Encoding'), coding === 'identity' ? null : coding);
      assert.deepEqual(
        coding === 'br' ? brotliDecompressSync(body) : coding === 'gzip' ? gunzipSync(body) : body,
        raw,
      );
      const head = await request({ 'Accept-Encoding': coding }, 'HEAD');
      assert.equal(head.headers.get('Content-Length'), String(body.length));
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      const cached = await request({
        'Accept-Encoding': coding,
        'If-None-Match': result.headers.get('ETag'),
      });
      assert.equal(cached.status, 304);
      assert.equal((await cached.arrayBuffer()).byteLength, 0);
    }
    assert.equal(
      (await request({ 'Accept-Encoding': 'br;q=0, gzip;q=1' })).headers.get('Content-Encoding'),
      'gzip',
    );
    assert.equal(
      (await request({ 'Accept-Encoding': 'br;q=0.5, identity;q=1' })).headers.get(
        'Content-Encoding',
      ),
      null,
    );
    assert.equal(
      (await request({ 'Accept-Encoding': 'br;q=0, gzip;q=0, identity;q=0' })).status,
      406,
    );
    assert.equal((await request({}, 'POST')).status, 405);
    assert.equal((await handler(new Request('http://review.test/missing.glb'))).status, 404);
    assert.equal((await handler(new Request('http://review.test/%2e%2e%2fsecret'))).status, 403);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale compressed sidecar cannot change the served GLB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relic-http-stale-'));
  try {
    const raw = Buffer.from('valid model payload '.repeat(100));
    await writeFile(join(root, 'test.glb'), raw);
    await writeFile(join(root, 'test.glb.br'), compress(Buffer.from('old model'), 'br'));
    const response = await createAssetHandler(root)(
      new Request('http://review.test/test.glb', { headers: { 'Accept-Encoding': 'br' } }),
    );
    assert.deepEqual(brotliDecompressSync(Buffer.from(await response.arrayBuffer())), raw);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
