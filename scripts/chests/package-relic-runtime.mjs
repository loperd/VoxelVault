/** Offline build only. Creates a portable review site; does not start a server. */
import { build } from 'vite';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(root, 'artifacts/relic-v4/runtime-package');
const explicitDracoPaths = {
  name: 'review-explicit-draco-paths',
  enforce: 'pre',
  transformIndexHtml: (html) => html.replace('<html ', '<html data-optimized="true" '),
  transform(code, id) {
    if (!id.endsWith('/loaders/DRACOLoader.js')) return;
    // Production loader supplies explicit decoder URLs. Prevent Vite emitting
    // five unused default assets in addition to that one shipped WASM decoder.
    let replaced = 0;
    const transformed = code.replace(
      /new URL\(\s*'(\.\.\/libs\/draco\/(?:gltf\/)?[^']+)'\s*,\s*import\.meta\.url\s*\)\.toString\(\)/g,
      (_match, path) => {
        replaced++;
        return `new URL('vendor/draco/${basename(path)}', globalThis.location.href).toString()`;
      },
    );
    if (replaced !== 5)
      throw new Error('DRACOLoader defaults changed; recheck the decoder packaging');
    return transformed;
  },
};
await build({
  configFile: false,
  root,
  base: './',
  publicDir: false,
  plugins: [explicitDracoPaths],
  build: {
    outDir: out,
    emptyOutDir: true,
    rollupOptions: { input: resolve(root, 'relic-review.html') },
  },
});
for (const version of ['relic-v3-geometry', 'relic-v3-pbr', 'relic-v4']) {
  const target = resolve(out, 'assets/chests', version + '-runtime');
  await mkdir(target, { recursive: true });
  await cp(
    resolve(root, 'assets/chests', version + '-runtime', 'relic.glb'),
    resolve(target, 'relic.glb'),
  );
}
await mkdir(resolve(out, 'vendor/draco'), { recursive: true });
for (const name of ['draco_wasm_wrapper.js', 'draco_decoder.wasm', 'LICENSE.txt', 'NOTICE.txt']) {
  await cp(resolve(root, 'public/vendor/draco', name), resolve(out, 'vendor/draco', name));
}
await mkdir(resolve(out, 'licenses'), { recursive: true });
await cp(resolve(root, 'node_modules/three/LICENSE'), resolve(out, 'licenses/three-LICENSE.txt'));
await cp(resolve(root, 'scripts/chests/http-assets.mjs'), resolve(out, 'serve.mjs'));
await writeFile(
  resolve(out, 'index.html'),
  '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=./relic-review.html"><a href="./relic-review.html">Relic V4 review</a>',
);
await writeFile(
  resolve(out, 'README.txt'),
  `Relic V4 — portable Three.js runtime review\n\nOpen a terminal in this extracted directory. Recommended lossless Brotli/Gzip delivery (Node.js 24+):\n  node serve.mjs\nFallback without HTTP compression (Python):\n  python3 -m http.server 4186 --bind 127.0.0.1\nOpen http://127.0.0.1:4186/relic-review.html\n\nDraco geometry + lossless WebP textures, 512px maximum edge. Crystals retain 256px. WebAssembly and WebP are required.\nNo npm, project checkout, CDN or account is needed to view this package.\nOpening via file:// is not supported by browser module/fetch rules.\n\nCompare V3/V4 with identical camera and exposure. Check neutral, showcase, application and weak-light modes, emissive ON/OFF and lid animation.\nThis package was built offline. GPU validation and visual approval are pending.\n\nAutomated capture from a checkout with Playwright installed:\n  RELIC_REVIEW_URL=http://127.0.0.1:4186/relic-review.html node scripts/chests/capture-relic-runtime.mjs --v4 --optimized\n`,
);
const files = [];
async function inventory(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) await inventory(path);
    else {
      const data = await readFile(path);
      files.push({
        path: relative(out, path),
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      });
    }
  }
}
await inventory(out);
await writeFile(
  resolve(out, 'manifest.json'),
  JSON.stringify({ status: 'built-offline-gpu-review-pending', files }, null, 2),
);
execFileSync(process.env.PYTHON ?? 'python3', [
  '-c',
  'import shutil,sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])',
  out,
  out,
]);
console.log(`Portable runtime: ${out}`);
console.log(`Archive: ${out}.zip`);
