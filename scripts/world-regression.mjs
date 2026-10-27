/**
 * Regression check of the built-in block worlds, in Node, no browser: every world of BLOCK_WORLDS
 * built with the review page's seed, and every mesh's geometry (positions, UVs, vertex colours,
 * sway, glow, normals, indices, instance matrices), material settings and world matrix hashed.
 * Two trees with the same digests draw the same meshes; pixels are the review page's job.
 *
 *   node scripts/world-regression.mjs                    this tree against HEAD
 *   node scripts/world-regression.mjs --base <rev>       this tree against a revision (git archive)
 *   node scripts/world-regression.mjs capture <file>     save this tree's digests (e.g. before a change)
 *   node scripts/world-regression.mjs compare <file>     this tree against saved digests
 *
 * A revision is extracted to a temporary folder with this repo's node_modules linked in, and is
 * removed afterwards. Exit code 1 when anything differs.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEED = 11;
const repo = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);

// Built-in atlases paint on a canvas; in Node a canvas that draws nothing is enough for geometry.
const context = new Proxy({}, { get: () => () => {} });
globalThis.document ??= {
  createElement: () => ({ getContext: () => context, width: 0, height: 0 }),
  createElementNS: () => ({ getContext: () => context, style: {} }),
};

/** One tree's digests: world id → the list of `mesh name:hash`, in scene order. */
async function digests(root) {
  const { BLOCK_WORLDS } = await import(
    pathToFileURL(join(root, 'src/adapters/outbound/worlds/index.ts')).href
  );
  const out = {};
  for (const [id, builder] of Object.entries(BLOCK_WORLDS).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const stage = builder.build(SEED),
      parts = [];
    stage.root.updateMatrixWorld(true);
    stage.root.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry,
        h = createHash('sha256'),
        bytes = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      for (const [name, a] of Object.entries(g.attributes).sort(([x], [y]) => (x < y ? -1 : 1))) {
        h.update(name);
        h.update(bytes(a.array));
      }
      if (g.index) h.update(bytes(g.index.array));
      if (o.isInstancedMesh) h.update(bytes(o.instanceMatrix.array));
      for (const m of [].concat(o.material))
        h.update(
          `${m.type}|${m.color?.getHexString?.()}|${Boolean(m.map)}|${m.vertexColors}|${m.transparent}|${m.opacity}|${m.alphaTest}|${m.depthWrite}|${m.side}`,
        );
      h.update(o.matrixWorld.elements.join(','));
      parts.push(`${o.name}:${h.digest('hex').slice(0, 16)}`);
    });
    out[id] = parts;
  }
  return out;
}

/** A revision's tree: extracted, node_modules linked, digests taken in a process of its own. */
async function digestsAt(rev) {
  const dir = await mkdtemp(join(tmpdir(), 'world-regression-'));
  try {
    execFileSync('sh', ['-c', `git -C "$1" archive "$2" | tar -x -C "$3"`, 'sh', repo, rev, dir]);
    await symlink(join(repo, 'node_modules'), join(dir, 'node_modules'));
    const out = join(dir, 'digests.json');
    execFileSync(process.execPath, [import.meta.filename, 'capture', out, '--tree', dir], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    return JSON.parse(await readFile(out, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function compare(base, here, label) {
  let same = true;
  for (const id of [...new Set([...Object.keys(base), ...Object.keys(here)])].sort()) {
    const a = base[id],
      b = here[id];
    if (!a || !b) {
      same = false;
      console.log(`${id}: only in ${a ? label : 'this tree'}`);
      continue;
    }
    const equal = JSON.stringify(a) === JSON.stringify(b);
    same &&= equal;
    if (equal) {
      console.log(`${id}: ${b.length} meshes, identical`);
      continue;
    }
    const differ = [...Array(Math.max(a.length, b.length)).keys()].filter((i) => a[i] !== b[i]);
    console.log(
      `${id}: DIFFERENT — ${differ.length} of ${Math.max(a.length, b.length)} meshes (${label} ${a.length}, this tree ${b.length})`,
    );
    for (const i of differ.slice(0, 5))
      console.log(`   #${i} ${label} ${a[i] ?? '—'}  this tree ${b[i] ?? '—'}`);
  }
  return same;
}

const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const tree = option('--tree') ?? repo,
  rev = option('--base') ?? 'HEAD';
const [command, file] = argv;
if (command === 'capture') {
  await writeFile(file, JSON.stringify(await digests(tree), null, 1));
} else if (command === 'compare') {
  process.exit(
    compare(JSON.parse(await readFile(file, 'utf8')), await digests(tree), file) ? 0 : 1,
  );
} else if (command === undefined) {
  process.exit(compare(await digestsAt(rev), await digests(tree), rev) ? 0 : 1);
} else {
  console.error('usage: world-regression.mjs [--base <rev>] | capture <file> | compare <file>');
  process.exit(2);
}
