/** Run from an ordinary terminal with GitHub access: node scripts/release.mjs
 * Checks first, then one commit, an atomic branch/tag push, deployment, GitHub release.
 * Existing released commits are never rewritten.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertReleaseState, commitSquashedRelease, releaseCommitMessage } from './release-git.mjs';
import { runReleaseCommand } from './release-process.mjs';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A plain semver version is required.');
const notes = `docs/releases/${version}.md`;
const message = releaseCommitMessage({
  version,
  notes: await readFile(resolve(root, notes), 'utf8'),
});
const run = (command, args, options = {}) =>
  runReleaseCommand(command, args, { cwd: root, ...options });
const git = (...args) =>
  run('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
if (git('branch', '--show-current') !== 'master') throw new Error('Run from master.');
const startingState = assertReleaseState({ git });
run('gh', ['auth', 'status']);
run('git', ['fetch', 'origin', 'master', '--tags']);
run('git', ['merge-base', '--is-ancestor', 'origin/master', 'HEAD']);
if (git('tag', '--list', version)) throw new Error(`Tag ${version} already exists.`);
const base = git('describe', '--tags', '--abbrev=0', '--match', '[0-9]*.[0-9]*.[0-9]*');
run('git', ['merge-base', '--is-ancestor', 'origin/master', `${base}^{commit}`]);
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
if (lock.version !== version || lock.packages[''].version !== version)
  throw new Error('Lockfile version differs.');

run('npm', ['ci']);
run('npm', ['run', 'test:all']);
run('npm', ['run', 'build']);
run('go', ['vet', './...'], { cwd: resolve(root, 'server') });
run('go', ['test', './...'], { cwd: resolve(root, 'server') });
run('helm', ['lint', 'deploy/helm/voxel-vault', '-f', 'deploy/helm/voxel-vault/values.prod.yaml']);
run('python3', [
  '-m',
  'unittest',
  'discover',
  '-s',
  'tests/deployment',
  '-p',
  'test_migration_job.py',
]);
run('node', ['--test', 'scripts/chests/test-http-assets.mjs']);
run('node', ['scripts/chests/test-relic-optimized.mjs', '--production']);
// A failed browser launch or scenario prevents committing and publishing.
run('node', ['scripts/mobile-performance.mjs', `artifacts/mobile-performance-${version}`]);
run('git', ['diff', '--check']);
// Fetch once more in case master moved during the checks.
run('git', ['fetch', 'origin', 'master']);
run('git', ['merge-base', '--is-ancestor', 'origin/master', 'HEAD']);
const commit = commitSquashedRelease({
  git,
  run,
  base,
  version,
  message,
  expectedState: startingState,
});
run('git', ['tag', '--annotate', version, '--message', `Release ${version}`]);
run('git', ['push', '--atomic', 'origin', 'HEAD:master', `refs/tags/${version}`]);

let workflow;
for (let attempt = 0; attempt < 30; attempt++) {
  const runs = JSON.parse(
    run(
      'gh',
      [
        'run',
        'list',
        '--workflow',
        'deploy.yml',
        '--commit',
        commit,
        '--event',
        'push',
        '--limit',
        '10',
        '--json',
        'databaseId,headBranch',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    ),
  );
  workflow = runs.find((run) => run.headBranch === version);
  if (workflow) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (!workflow)
  throw new Error(`Tag pushed, but deployment was not found. Check GitHub Actions for ${version}.`);
run('gh', ['run', 'watch', String(workflow.databaseId), '--exit-status']);
run('gh', [
  'release',
  'create',
  version,
  '--verify-tag',
  '--title',
  version,
  '--notes-file',
  notes,
]);
console.log(`Released ${version} (${commit}).`);
