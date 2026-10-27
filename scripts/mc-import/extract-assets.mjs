/**
 * The reference for the importer's fidelity check (scripts/mc-import/fidelity.mjs): blockstates,
 * block models, block tiles and colormaps out of the user's own Minecraft client jar, into an ignored
 * folder. Mojang's files are never part of the repository, a pack or a test fixture.
 *
 *   node scripts/mc-import/extract-assets.mjs <client.jar> [out dir]    default artifacts/mc-import/vanilla-1.19.2
 *
 * The metrics in docs/worlds/minecraft-import.md were taken with the 1.19.2 client jar
 * (piston-data.mojang.com/v1/objects/<SHA1>/client.jar); another jar is refused unless --any-jar.
 * The importer takes the game's version from version.json (`world_version`, the data version) and
 * compares the models only with a schematic of that data version.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const VERSION = '1.19.2';
export const SHA1 = '055b30d860ead928cba3849ba920c88b6950b654';
const PATHS = [
  'version.json',
  'assets/minecraft/blockstates/*',
  'assets/minecraft/models/block/*',
  'assets/minecraft/textures/block/*',
  'assets/minecraft/textures/colormap/*',
];

if (import.meta.main) {
  const args = process.argv.slice(2),
    anyJar = args.includes('--any-jar'),
    [jar, outArg] = args.filter((a) => a !== '--any-jar');
  if (!jar) {
    console.error('usage: extract-assets.mjs <client.jar> [out dir] [--any-jar]');
    process.exit(2);
  }
  const sha1 = createHash('sha1').update(readFileSync(jar)).digest('hex');
  if (sha1 !== SHA1 && !anyJar) {
    console.error(
      `${jar}: sha1 ${sha1}, not the ${VERSION} client jar (${SHA1}); --any-jar to use it anyway`,
    );
    process.exit(1);
  }
  const out = resolve(
    outArg ?? resolve(import.meta.dirname, `../../artifacts/mc-import/vanilla-${VERSION}`),
  );
  if (existsSync(out) && readdirSync(out).length && !existsSync(resolve(out, 'version.json'))) {
    console.error(`${out}: not empty and not an extracted jar`);
    process.exit(1);
  }
  execFileSync('unzip', ['-q', '-o', jar, ...PATHS, '-d', out], { stdio: 'inherit' });
  const id = JSON.parse(readFileSync(resolve(out, 'version.json'), 'utf8')).id;
  // Which jar it came from, for fidelity.mjs's record; the importer goes by version.json.
  writeFileSync(
    resolve(out, 'extracted-from.json'),
    `${JSON.stringify({ jar: sha1, version: id })}\n`,
  );
  const count = (dir) => readdirSync(resolve(out, 'assets/minecraft', dir)).length;
  console.log(
    `${out}: Minecraft ${id} (jar sha1 ${sha1}); ${count('blockstates')} blockstates, ${count('models/block')} block models, ${count('textures/block')} block tiles`,
  );
}
