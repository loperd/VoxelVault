import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Dependency-free local preview; serves only client TypeScript and public image/JSON assets. */
export async function handleCanvasPreview(request, response) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405);
    response.end();
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let directory, relative;
    if (pathname === '/' || pathname === '/canvas-preview.html') {
      directory = root;
      relative = 'canvas-preview.html';
    } else if (pathname.startsWith('/src/') && pathname.endsWith('.ts')) {
      directory = resolve(root, 'src');
      relative = pathname.slice(5);
    } else if (
      ['/items.json', '/selected_prize.json'].includes(pathname) ||
      (pathname.startsWith('/static/icon/') && /\.(png|jpe?g)$/i.test(pathname))
    ) {
      directory = resolve(root, 'public');
      relative = pathname.slice(1);
    } else {
      response.writeHead(404);
      response.end();
      return;
    }
    const file = resolve(directory, relative);
    if (!file.startsWith(directory + sep)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const extension = extname(file);
    let body = await readFile(file);
    if (extension === '.ts')
      body = Buffer.from(stripTypeScriptTypes(body.toString('utf8'), { mode: 'strip' }));
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.ts': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
    }[extension.toLowerCase()];
    response.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    response.writeHead(error?.code === 'ENOENT' || error instanceof URIError ? 404 : 500);
    response.end();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.CANVAS_PREVIEW_PORT ?? 4174);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid CANVAS_PREVIEW_PORT.');
  const server = createServer((request, response) => {
    void handleCanvasPreview(request, response);
  });
  server.on('error', (error) => {
    console.error(`Canvas preview: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () =>
    console.log(`Canvas preview: http://127.0.0.1:${port}/canvas-preview.html`),
  );
  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
}
