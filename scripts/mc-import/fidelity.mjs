/**
 * The importer's fidelity against Minecraft's own blockstates, models and tiles: the reference
 * schematic imported as docs/worlds/minecraft-import.md reports it, the shares of its block cells
 * that are exact, unverified, approximated and unsupported, overall and by aspect, and what every
 * input was (sha256), so a result can be told apart from another.
 *
 *   node scripts/mc-import/extract-assets.mjs <client.jar>     once: the reference, ignored, local only
 *   node scripts/mc-import/fidelity.mjs [--schematic <file>] [--scenes <dir>] [--reference <dir>] [--tiles <dir>] [--out <dir>] [--expect-reference] [--strict]
 *
 * Defaults: research/schematics/dungeon-entrance.schem (the user's download, not redistributable),
 * its scenes in research/mc-import, the reference in artifacts/mc-import/vanilla-1.19.2, tiles from
 * the reference, reports in artifacts/mc-import/fidelity. --tiles imports with other tiles (a user's
 * pack): geometry, material and state are checked against the same models; texture says whether its
 * pixels are the reference's.
 *
 * Every run prints and writes (fidelity.json) the sha256 of each input and whether it is the one the
 * documented result was taken with (REFERENCE_RUN). --expect-reference: exit 1 unless every input and
 * every number is the documented one. --strict is handed to the importer: a reference of another
 * game than the schematic's is an error.
 *
 * Input identity: a file's sha256; a folder's is the sha256 of its lines `<path>\t<sha256 of file>\n`,
 * sorted by path, over the files the importer reads — models: version.json,
 * assets/minecraft/blockstates/*.json, assets/minecraft/models/block/*.json; tiles:
 * assets/minecraft/textures/block/*.png (or *.png of a flat folder).
 *
 * Formulas, per import: N = block cells (non-air, inside the region); share(r) = cells whose state
 * is r / N. A state's overall result is the worst of its four aspects
 * (exact < unverified < approximated < unsupported); share_aspect(r) = cells whose state is r in
 * that aspect / N. The numbers are the report's `totals` and `aspects`, divided by `cells.blocks`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { SHA1, VERSION } from './extract-assets.mjs';

const repo = resolve(import.meta.dirname, '../..');
const SOURCE =
  'planetminecraft.com — dungeon-entrance.schem (downloaded by the user 2026-10-21); licence not known: not for distribution';
const RESULTS = ['exact', 'unverified', 'approximated', 'unsupported'],
  ASPECTS = ['geometry', 'material', 'texture', 'state'];
const MAPPING = 'tools/mc-import/vanilla-mapping.json';
// The full building, and the cutaway: the building without the terrain around it.
const IMPORTS = [
  { id: 'mc-dungeon-entrance', scene: 'dungeon-entrance.interior.json' },
  { id: 'mc-dungeon-cutaway', scene: 'dungeon-entrance.cutaway.json', region: '1,0,1:21,19,34' },
];

/** The documented result: its inputs (sha256) and, per import, the cells of each result overall and by aspect. */
const REFERENCE_RUN = {
  inputs: {
    schematic: '2cdcf71d7dd4e2fca13005b3a2d94ce7720b373618b025e2b4776c3b317eb448',
    'dungeon-entrance.interior.json':
      '82a7871443c8ea1c3a04efda96c8df285a644d33bfe6ae772bf42a1dfaa949b9',
    'dungeon-entrance.cutaway.json':
      '176a48771fb6900884c9abc644248b3b1b3f94ec9ae9ea77225fbff7a43f0d20',
    mapping: 'd6e8dc3e5e779e1080cd7022098d05d924317c89f4e35c869b85572ca42fa284',
    models: 'a16f9deeee262c1e9e2c767e284cf43cd04588f30396f70a7a78d4bbdf1c81cc',
    tiles: '5f03528388216428ddac21b1cfd05d8dd85c5e13972b60098e3840de4b11593c',
  },
  results: {
    'mc-dungeon-entrance': {
      blocks: 9765,
      overall: [7633, 0, 2132, 0],
      geometry: [9743, 0, 22, 0],
      material: [7650, 0, 2115, 0],
      texture: [9765, 0, 0, 0],
      state: [9396, 352, 17, 0],
    },
    'mc-dungeon-cutaway': {
      blocks: 5798,
      overall: [3892, 0, 1906, 0],
      geometry: [5776, 0, 22, 0],
      material: [3909, 0, 1889, 0],
      texture: [5798, 0, 0, 0],
      state: [5444, 337, 17, 0],
    },
  },
};

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : argv[i + 1];
};
const at = (p) => resolve(repo, p);
const schematic = at(option('--schematic', 'research/schematics/dungeon-entrance.schem'));
const scenes = at(option('--scenes', 'research/mc-import'));
const reference = at(option('--reference', `artifacts/mc-import/vanilla-${VERSION}`));
const tiles = at(option('--tiles', reference));
const out = at(option('--out', 'artifacts/mc-import/fidelity'));
const expectReference = argv.includes('--expect-reference'),
  strict = argv.includes('--strict');

for (const [what, path] of [
  ['schematic', schematic],
  ['reference blockstates', join(reference, 'assets/minecraft/blockstates')],
  ...IMPORTS.map((i) => [`scene ${i.scene}`, join(scenes, i.scene)]),
]) {
  if (!existsSync(path)) {
    console.error(
      `${what}: ${path} does not exist${what.startsWith('reference') ? ' (scripts/mc-import/extract-assets.mjs)' : ''}`,
    );
    process.exit(2);
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (path) => sha256(readFileSync(path));
/** A folder's identity: its files under these subfolders with these endings, by path and content. */
const treeHash = (root, parts) => {
  const lines = [];
  for (const [sub, ending] of parts) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    if (ending === null) {
      lines.push(`${sub}\t${fileHash(dir)}\n`);
      continue;
    }
    for (const name of readdirSync(dir))
      if (name.endsWith(ending) && !name.startsWith('.'))
        lines.push(`${sub}/${name}\t${fileHash(join(dir, name))}\n`);
  }
  return sha256(lines.sort().join(''));
};
const tileHash = (root) =>
  existsSync(join(root, 'assets/minecraft/textures/block'))
    ? treeHash(root, [['assets/minecraft/textures/block', '.png']])
    : treeHash(root, [['.', '.png']]);
const said = existsSync(join(reference, 'version.json'))
  ? JSON.parse(readFileSync(join(reference, 'version.json'), 'utf8'))
  : undefined;
const extracted = existsSync(join(reference, 'extracted-from.json'))
  ? JSON.parse(readFileSync(join(reference, 'extracted-from.json'), 'utf8'))
  : undefined;
const inputs = {
  schematic: fileHash(schematic),
  ...Object.fromEntries(IMPORTS.map((i) => [i.scene, fileHash(join(scenes, i.scene))])),
  mapping: fileHash(at(MAPPING)),
  models: treeHash(reference, [
    ['version.json', null],
    ['assets/minecraft/blockstates', '.json'],
    ['assets/minecraft/models/block', '.json'],
  ]),
  tiles: tileHash(tiles),
  ...(tiles !== reference ? { 'reference tiles': tileHash(reference) } : {}),
};
const differing = Object.keys(REFERENCE_RUN.inputs).filter(
  (k) => inputs[k] !== REFERENCE_RUN.inputs[k],
);

mkdirSync(out, { recursive: true });
const rel = (p) => relative(repo, p) || '.';
const lines = [
  `# Import fidelity against ${said ? `Minecraft ${said.id} (data version ${said.world_version})` : 'a reference that does not say which game it is'}`,
  '',
  `Reference \`${rel(reference)}\`${extracted ? ` (client jar sha1 ${extracted.jar})` : ''}, tiles \`${rel(tiles)}\`, schematic \`${rel(schematic)}\`, scenes \`${rel(scenes)}\`, mapping \`${MAPPING}\`.`,
  '',
  '| Input | sha256 | The documented one |',
  '|---|---|---|',
  ...Object.entries(inputs).map(
    ([k, v]) =>
      `| ${k} | \`${v}\` | ${k in REFERENCE_RUN.inputs ? (v === REFERENCE_RUN.inputs[k] ? 'yes' : 'no') : '—'} |`,
  ),
  '',
];
const results = {},
  numbersDiffer = [];
for (const { id, scene, region } of IMPORTS) {
  const args = [
    'tools/mc-import/cli.ts',
    schematic,
    '--mapping',
    MAPPING,
    '--resource-pack',
    tiles,
    '--models',
    reference,
    '--source',
    SOURCE,
    '--scene',
    join(scenes, scene),
    '--out',
    join(out, id),
    ...(region ? ['--region', region] : []),
    ...(strict ? ['--strict'] : []),
  ];
  console.log(`node ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
  try {
    execFileSync(process.execPath, args, { cwd: repo, stdio: ['ignore', 'ignore', 'inherit'] });
  } catch {
    console.error(`${id}: the importer failed`);
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(join(out, `${id}.import-report.json`), 'utf8')),
    n = report.cells.blocks;
  const cells = {
    blocks: n,
    overall: RESULTS.map((r) => report.totals[r].cells),
    ...Object.fromEntries(ASPECTS.map((a) => [a, RESULTS.map((r) => report.aspects[a][r].cells)])),
  };
  results[id] = { ...cells, reference: report.reference ?? null };
  if (JSON.stringify(cells) !== JSON.stringify(REFERENCE_RUN.results[id])) numbersDiffer.push(id);
  const cell = ({ states, cells }) => `${states} / ${cells} (${((100 * cells) / n).toFixed(1)} %)`;
  const ref = report.reference;
  lines.push(
    `## ${id}${region ? ` (region ${region})` : ''}: ${n} block cells`,
    '',
    `Checked against: ${!ref ? 'nothing' : ref.compared ? `${rel(ref.name)}, Minecraft ${ref.minecraft} (data version ${ref.dataVersion})` : `nothing — ${ref.why}`}.`,
    '',
    `| | ${RESULTS.join(' | ')} |`,
    `|---|${RESULTS.map(() => '---').join('|')}|`,
    `| overall | ${RESULTS.map((r) => cell(report.totals[r])).join(' | ')} |`,
    ...ASPECTS.map(
      (a) => `| ${a} | ${RESULTS.map((r) => cell(report.aspects[a][r])).join(' | ')} |`,
    ),
    '',
    'Cells are states / cells (share of block cells).',
    '',
  );
}
const reproduced = !differing.length && !numbersDiffer.length;
const status = reproduced
  ? `the documented reference run (Minecraft ${VERSION}, jar sha1 ${SHA1}): every input and every number reproduced`
  : `not the documented reference run: ${[differing.length ? `inputs differ (${differing.join(', ')})` : '', numbersDiffer.length ? `numbers differ (${numbersDiffer.join(', ')})` : ''].filter(Boolean).join('; ')}`;
lines.splice(2, 0, `Status: ${status}.`, '');
writeFileSync(join(out, 'fidelity.md'), lines.join('\n'));
writeFileSync(
  join(out, 'fidelity.json'),
  `${JSON.stringify({ status, reproduced, minecraft: said ? { id: said.id, dataVersion: said.world_version } : null, jar: extracted?.jar ?? null, inputs, results }, null, 1)}\n`,
);
console.log(`\n${lines.join('\n')}`);
if (expectReference && !reproduced) {
  console.error(`--expect-reference: ${status}`);
  process.exit(1);
}
