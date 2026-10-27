/** Build CDN/origin sidecars; never changes the decoded GLB. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { compress } from './http-assets.mjs';
const records = [];
for (const version of ['relic-v3-geometry', 'relic-v3-pbr', 'relic-v4']) {
  const path = new URL(`../../assets/chests/${version}-runtime/relic.glb`, import.meta.url),
    raw = await readFile(path),
    sizes = {};
  for (const coding of ['br', 'gzip']) {
    const encoded = compress(raw, coding);
    await writeFile(new URL(path.href + (coding === 'br' ? '.br' : '.gz')), encoded);
    sizes[coding] = encoded.length;
  }
  records.push({
    version,
    decodedBytes: raw.length,
    ...sizes,
    decodedSha256: createHash('sha256').update(raw).digest('hex'),
    roundtripBitExact: true,
    requiredHeaders: {
      'Content-Type': 'model/gltf-binary',
      Vary: 'Accept-Encoding',
      'Content-Encoding': 'br or gzip, matching selected body',
    },
    deployment: 'prepared, not deployed',
  });
}
await writeFile(
  new URL('../../artifacts/relic-v4/lossless-study/transport.json', import.meta.url),
  JSON.stringify(records, null, 2),
);
console.log(
  JSON.stringify(
    records.map(({ version, decodedBytes, br, gzip }) => ({ version, decodedBytes, br, gzip })),
    null,
    2,
  ),
);
