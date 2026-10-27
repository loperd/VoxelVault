/**
 * Minecraft schematic → world pack, offline.
 *
 *   node tools/mc-import/cli.ts <in.schem> --mapping <mapping.json> --resource-pack <dir> --out <pack dir>
 *     [--models <dir>] [--id <pack id>] [--region x0,y0,z0:x1,y1,z1] [--scene <scene.json>] [--author <name>] [--license <spdx>] [--source <text>] [--strict]
 *
 * --resource-pack: a folder laid out as a resource pack (assets/minecraft/textures/block/*.png), or a
 *   flat folder of tiles. Its tiles are the pack's; the importer has none of its own.
 * --models: the reference every state is checked against (models.ts, verify.ts): blockstates, models
 *   and tiles of the game, as scripts/mc-import/extract-assets.mjs takes them out of a client jar; by
 *   default the --resource-pack itself, when it has blockstates. Its version.json says which game it
 *   is; its models count only for a schematic of that data version. Without a reference, or with one
 *   of another or an unknown version, nothing in the report is exact: it is `unverified`.
 * --region: import only these cells (inclusive), e.g. a building without the terrain or case around it;
 *   the report counts the cells left out.
 * --scene: markers, cameras, environment and sides for the pack (pack.json's own keys); left out,
 *   the importer makes them from the structure and says so in the report.
 * --strict: fail when any state is unsupported, or when the reference is not of the schematic's game
 *   (the pack is still written, for a look).
 * Writes <out>/ (pack.json, structure.u16, textures/), and <out>.import-report.json and .md beside
 * it; then reads the pack back with readWorldPack, as the game would.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { readWorldPack } from '../../packages/blockworld/src/pack/read.ts';
import { importSchematic, type Scene } from './import.ts';
import { readMapping } from './mapping.ts';
import { reportMarkdown } from './report.ts';
import { cropSchematic, readSchematic } from './schem.ts';

const argv = process.argv.slice(2);
const option = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};
const mappingPath = option('--mapping'),
  resourcePack = option('--resource-pack'),
  outArg = option('--out'),
  modelsArg = option('--models');
const regionArg = option('--region'),
  scenePath = option('--scene'),
  author = option('--author'),
  license = option('--license'),
  source = option('--source'),
  idArg = option('--id');
const strict = flag('--strict'),
  [input] = argv;
if (!input || !mappingPath || !resourcePack || !outArg || argv.length !== 1) {
  console.error(
    'usage: cli.ts <in.schem> --mapping <mapping.json> --resource-pack <dir> --out <pack dir> [--id] [--scene] [--author] [--license] [--source] [--strict]',
  );
  process.exit(2);
}
const out = resolve(outArg),
  id =
    idArg ??
    basename(out)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-');

const blocksDir = join(resourcePack, 'assets', 'minecraft', 'textures', 'block'),
  tiles = existsSync(blocksDir) ? blocksDir : resourcePack;
const files = new Map<string, Uint8Array>();
for (const name of await readdir(tiles))
  if (name.endsWith('.png'))
    files.set(name.slice(0, -4), new Uint8Array(await readFile(join(tiles, name))));
const referenceRoot = modelsArg ?? resourcePack,
  modelsRoot = join(referenceRoot, 'assets', 'minecraft');
if (modelsArg && !existsSync(join(modelsRoot, 'blockstates'))) {
  console.error(`--models: ${modelsRoot}/blockstates does not exist`);
  process.exit(2);
}
const json = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};
// Which game the reference is, by what it says of itself.
const said = json(join(referenceRoot, 'version.json')) as
  { id?: unknown; world_version?: unknown } | undefined;
const version =
  typeof said?.id === 'string' && Number.isInteger(said.world_version)
    ? { id: said.id, dataVersion: said.world_version as number }
    : undefined;
const referenceTiles = join(modelsRoot, 'textures', 'block');
const models = existsSync(join(modelsRoot, 'blockstates'))
  ? {
      name: referenceRoot,
      ...(version ? { version } : {}),
      blockstate: (name: string) => json(join(modelsRoot, 'blockstates', `${name}.json`)),
      model: (path: string) => json(join(modelsRoot, 'models', `${path}.json`)),
      ...(existsSync(referenceTiles)
        ? {
            texture: (name: string) => {
              const path = join(referenceTiles, `${name}.png`);
              return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
            },
          }
        : {}),
    }
  : undefined;
const resources = {
  name: `${resourcePack} (${files.size} tiles)`,
  texture: (name: string) => files.get(name),
  ...(models ? { models } : {}),
};

const whole = readSchematic(new Uint8Array(await readFile(input)));
const region = regionArg
  ?.split(':')
  .map((c) => c.split(',').map(Number) as [number, number, number]);
if (region && (region.length !== 2 || region.some((c) => c.length !== 3))) {
  console.error('--region x0,y0,z0:x1,y1,z1');
  process.exit(2);
}
const schem = region ? cropSchematic(whole, region[0]!, region[1]!) : whole;
const mapping = readMapping(JSON.parse(await readFile(mappingPath, 'utf8')));
const scene = scenePath ? (JSON.parse(await readFile(scenePath, 'utf8')) as Scene) : undefined;
const result = importSchematic(schem, mapping, resources, {
  id,
  ...(scene ? { scene } : {}),
  ...(region ? { region: { from: region[0]!, to: region[1]!, of: whole.size } } : {}),
  credits: {
    authors: author ? [author] : ['unknown'],
    license: license ?? 'unknown',
    source: source ?? `${basename(input)}, imported by tools/mc-import`,
  },
});

// The output folder is the importer's: replaced only when it holds a pack (or nothing).
if (existsSync(out)) {
  const entries = await readdir(out);
  if (entries.length && !entries.includes('pack.json')) {
    console.error(`${out} is not empty and holds no pack; not replacing it.`);
    process.exit(2);
  }
  await rm(out, { recursive: true });
}
for (const [path, bytes] of result.files) {
  await mkdir(dirname(join(out, path)), { recursive: true });
  await writeFile(join(out, path), bytes);
}
await writeFile(`${out}.import-report.json`, `${JSON.stringify(result.report, null, 1)}\n`);
await writeFile(`${out}.import-report.md`, reportMarkdown(result.report, id));

// The pack as the game reads it.
await readWorldPack(
  async (path) => {
    const b = result.files.get(path);
    if (!b) throw new Error(`no ${path}`);
    return b.slice().buffer;
  },
  { signal: new AbortController().signal },
);
const t = result.report.totals,
  n = result.report.cells.blocks;
console.log(
  `${out}: ${result.report.blocks} blocks, ${result.report.textures.length} tiles; read back by readWorldPack`,
);
const ref = result.report.reference;
console.log(
  `  checked against: ${!ref ? 'nothing (every state unverified)' : ref.compared ? `${ref.name}, Minecraft ${ref.minecraft} (data version ${ref.dataVersion})` : `nothing: ${ref.why}`}`,
);
for (const k of ['exact', 'unverified', 'approximated', 'unsupported'] as const)
  console.log(
    `  ${k.padEnd(12)} ${String(t[k].states).padStart(4)} states  ${String(t[k].cells).padStart(6)} cells  ${((100 * t[k].cells) / n).toFixed(1)} %`,
  );
console.log(`report: ${out}.import-report.md`);
if (strict && ref && !ref.compared) {
  console.error(`--strict: ${ref.why}`);
  process.exit(1);
}
if (strict && t.unsupported.states) {
  console.error(`--strict: ${t.unsupported.states} unsupported states`);
  process.exit(1);
}
