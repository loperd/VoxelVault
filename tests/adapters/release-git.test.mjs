import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertReleaseState,
  commitSquashedRelease,
  releaseCommitMessage,
} from '../../scripts/release-git.mjs';
import { runReleaseCommand } from '../../scripts/release-process.mjs';

async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), 'release-git-test-'));
  const run = (command, args, options = {}) =>
    execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    }).trim();
  const git = (...args) => run('git', args);
  git('init', '-b', 'master');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(cwd, 'base.txt'), 'base');
  git('add', '.');
  git('commit', '-m', 'base');
  git('tag', '0.3.9');
  const base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/master', base);
  for (const name of ['one', 'two']) {
    await writeFile(join(cwd, `${name}.txt`), name);
    git('add', '.');
    git('commit', '-m', name);
  }
  await rm(join(cwd, 'base.txt'));
  await writeFile(join(cwd, 'one.txt'), 'changed');
  await writeFile(join(cwd, 'new.txt'), 'new');
  git('add', '--all'); // The operator explicitly selects release changes before validation.
  return {
    cwd,
    run,
    git,
    base,
    previous: git('rev-parse', 'HEAD'),
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

test('production release runner sends the message to a real git commit through stdin', async () => {
  const r = await repository();
  try {
    const message = 'Release 0.4.0\n\nThe message reaches git unchanged.\n';
    runReleaseCommand('git', ['commit', '--file', '-'], { cwd: r.cwd, input: message });
    assert.equal(r.git('log', '-1', '--format=%B'), message.trim());
    assert.equal(r.git('status', '--porcelain'), '');
  } finally {
    await r.cleanup();
  }
});

test('release combines reviewed local commits and staged changes into one commit with a backup', async () => {
  const r = await repository();
  try {
    const expectedState = assertReleaseState(r);
    const commit = commitSquashedRelease({
      ...r,
      base: '0.3.9',
      version: '0.3.10',
      message: 'release\n',
      expectedState,
    });
    assert.equal(r.git('rev-parse', `${commit}^`), r.base);
    assert.equal(r.git('rev-list', '--count', '0.3.9..HEAD'), '1');
    assert.equal(r.git('status', '--porcelain'), '');
    assert.equal(await readFile(join(r.cwd, 'one.txt'), 'utf8'), 'changed');
    assert.equal(await readFile(join(r.cwd, 'new.txt'), 'utf8'), 'new');
    await assert.rejects(readFile(join(r.cwd, 'base.txt')), { code: 'ENOENT' });
    const backup = r.git('for-each-ref', '--format=%(objectname)', 'refs/heads/release-backup/');
    assert.equal(backup, r.previous);
  } finally {
    await r.cleanup();
  }
});

for (const staged of [false, true]) {
  test(`release rejects ${staged ? 'staged' : 'unstaged'} source changes after validation`, async () => {
    const r = await repository();
    try {
      const expectedState = assertReleaseState(r);
      await writeFile(join(r.cwd, 'one.txt'), 'changed after checks');
      if (staged) r.git('add', 'one.txt');
      const status = r.git('status', '--porcelain');
      assert.throws(
        () =>
          commitSquashedRelease({
            ...r,
            base: '0.3.9',
            version: '0.4.0',
            message: 'release\n',
            expectedState,
          }),
        /fully staged|source changed/,
      );
      assert.equal(r.git('rev-parse', 'HEAD'), r.previous);
      assert.equal(r.git('status', '--porcelain'), status);
      assert.equal(r.git('for-each-ref', '--format=%(refname)', 'refs/heads/release-backup/'), '');
    } finally {
      await r.cleanup();
    }
  });
}

test('release rejects unrelated untracked files without staging them', async () => {
  const r = await repository();
  try {
    await writeFile(join(r.cwd, 'unrelated.txt'), 'ongoing work');
    const status = r.git('status', '--porcelain');
    assert.throws(
      () => commitSquashedRelease({ ...r, base: '0.3.9', version: '0.4.0', message: 'release\n' }),
      /untracked/,
    );
    assert.equal(r.git('status', '--porcelain'), status);
    assert.equal(r.git('rev-parse', 'HEAD'), r.previous);
    assert.ok(!r.git('diff', '--cached', '--name-only').includes('unrelated.txt'));
  } finally {
    await r.cleanup();
  }
});

test('release rejects HEAD changes after validation', async () => {
  const r = await repository();
  try {
    const expected = assertReleaseState(r);
    r.git('commit', '-m', 'concurrent change');
    assert.throws(() => assertReleaseState({ ...r, expected }), /source changed/);
  } finally {
    await r.cleanup();
  }
});

test('release commit describes the requested version using its release notes', () => {
  assert.equal(
    releaseCommitMessage({ version: '0.4.0', notes: '# 0.4.0\n\nRelease preparation.\n' }),
    'Release 0.4.0\n\nRelease preparation.\n',
  );
  assert.throws(
    () => releaseCommitMessage({ version: '0.4.0', notes: '# 0.3.11\n\nOld release.\n' }),
    /heading differs/,
  );
  assert.throws(
    () => releaseCommitMessage({ version: '0.4.0', notes: '# 0.4.0\n' }),
    /must describe/,
  );
});

test('release refuses to squash commits already published after the previous tag', async () => {
  const r = await repository();
  try {
    r.git('update-ref', 'refs/remotes/origin/master', r.previous);
    const status = r.git('status', '--porcelain');
    assert.throws(() =>
      commitSquashedRelease({ ...r, base: '0.3.9', version: '0.3.10', message: 'release\n' }),
    );
    assert.equal(r.git('rev-parse', 'HEAD'), r.previous);
    assert.equal(r.git('status', '--porcelain'), status);
  } finally {
    await r.cleanup();
  }
});

test('a failed squash commit restores HEAD and retains every staged change', async () => {
  const r = await repository();
  try {
    const run = (command, args, options) => {
      if (command === 'git' && args[0] === 'commit') throw new Error('commit rejected');
      return r.run(command, args, options);
    };
    assert.throws(
      () =>
        commitSquashedRelease({
          ...r,
          run,
          base: '0.3.9',
          version: '0.3.10',
          message: 'release\n',
        }),
      /commit rejected/,
    );
    assert.equal(r.git('rev-parse', 'HEAD'), r.previous);
    assert.equal(await readFile(join(r.cwd, 'new.txt'), 'utf8'), 'new');
    assert.ok(r.git('diff', '--cached', '--name-only').includes('new.txt'));
  } finally {
    await r.cleanup();
  }
});
