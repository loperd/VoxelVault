import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const check = process.argv.includes('--check');
const root = fileURLToPath(new URL('../', import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || '');
    process.stdout.write(result.stdout || '');
    process.exit(result.status || 1);
  }
  return result.stdout || '';
}

const files = run('git', ['ls-files', '-co', '--exclude-standard', '-z'])
  .split('\0')
  .filter((path) => path && existsSync(new URL(path, new URL('../', import.meta.url))));
const goFiles = files.filter((path) => path.startsWith('server/') && path.endsWith('.go'));
const unformatted = run('gofmt', [check ? '-l' : '-w', ...goFiles]);
if (check && unformatted) {
  process.stderr.write(unformatted);
  process.exit(1);
}

const sourceFiles = files.filter(
  (path) =>
    /\.(?:ts|tsx|js|mjs|cjs|css|scss|json|jsonc|html|ya?ml)$/.test(path) &&
    !path.startsWith('assets/') &&
    !path.startsWith('experiments/') &&
    !path.startsWith('public/models/') &&
    !/^deploy\/helm\/[^/]+\/templates\//.test(path) &&
    !path.endsWith('package-lock.json'),
);
run(
  process.execPath,
  ['node_modules/prettier/bin/prettier.cjs', check ? '--check' : '--write', ...sourceFiles],
  {
    stdio: 'inherit',
  },
);
