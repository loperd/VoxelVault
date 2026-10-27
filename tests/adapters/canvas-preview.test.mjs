import assert from 'node:assert/strict';
import test from 'node:test';
import { handleCanvasPreview } from '../../scripts/canvas-preview.mjs';

async function request(url, method = 'GET') {
  const result = {};
  await handleCanvasPreview(
    { url, method },
    {
      writeHead(status, headers) {
        result.status = status;
        result.headers = headers;
      },
      end(body) {
        result.body = body?.toString('utf8') ?? '';
      },
    },
  );
  return result;
}

test('standalone canvas preview serves browser-ready modules and real catalog without installed dependencies', async () => {
  const html = await request('/canvas-preview.html');
  assert.equal(html.status, 200);
  assert.match(html.body, /src\/dev\/canvas-preview.ts/);
  const module = await request('/src/dev/canvas-preview.ts');
  assert.equal(module.status, 200);
  assert.match(module.headers['Content-Type'], /javascript/);
  assert.doesNotMatch(module.body, /import type|readonly Item/);
  assert.match(module.body, /CanvasRoulette/);
  const catalog = await request('/items.json');
  assert.equal(JSON.parse(catalog.body).length, 14);
  const adapter = await request('/src/adapters/outbound/browser/canvas-roulette.ts');
  assert.equal(adapter.status, 200);
  assert.doesNotMatch(adapter.body, /implements RoulettePresentationPort/);
  assert.match(adapter.body, /drawImage/);
  const pending = ['/src/dev/canvas-preview.ts'],
    visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const response = await request(path);
    assert.equal(response.status, 200, path);
    for (const match of response.body.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.ok(match[1].startsWith('.'), 'preview needs no npm packages');
      pending.push(new URL(match[1], `http://localhost${path}`).pathname);
    }
  }
  assert.ok(visited.has('/src/adapters/outbound/browser/canvas-roulette.ts'));
  for (const item of JSON.parse(catalog.body))
    assert.equal((await request(item.image)).status, 200, item.image);
});

test('canvas preview rejects private paths, encoded traversal, unsupported methods and missing assets', async () => {
  for (const url of [
    '/package.json',
    '/.env',
    '/.git/config',
    '/src/%2e%2e%2fpackage.json.ts',
    '/src/%2fetc%2fpasswd.ts',
    '/src/missing.ts',
    '/static/icon/missing.png',
    '/%ZZ',
  ]) {
    assert.equal((await request(url)).status, 404, url);
  }
  assert.equal((await request('/items.json', 'POST')).status, 405);
  const head = await request('/items.json', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});
