import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const three = resolve(dirname(fileURLToPath(import.meta.resolve('three'))), '..');
const source = resolve(three, 'examples/jsm/libs/draco/gltf');
const target = resolve(project, 'public/vendor/draco');

await mkdir(target, { recursive: true });
for (const name of ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js']) {
  await copyFile(resolve(source, name), resolve(target, name));
}
await copyFile(resolve(project, 'licenses/Apache-2.0.txt'), resolve(target, 'LICENSE.txt'));
await writeFile(
  resolve(target, 'NOTICE.txt'),
  'Draco geometry compression — Google. Distributed under the Apache License 2.0.\n' +
    'Source: https://github.com/google/draco\nDecoder files supplied by the installed Three.js package.\n',
);
console.log('Draco decoder assets synchronized with the installed Three.js release.');
