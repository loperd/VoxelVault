/** Only explicitly staged work and reviewed local commits may enter a release. */
export function assertReleaseState({ git, expected }) {
  if (git('diff', '--name-only') || git('ls-files', '--others', '--exclude-standard')) {
    throw new Error(
      'Release requires a fully staged working tree with no untracked files. Isolate unrelated work first.',
    );
  }
  const state = { head: git('rev-parse', 'HEAD'), tree: git('write-tree') };
  if (expected && (state.head !== expected.head || state.tree !== expected.tree)) {
    throw new Error('Release source changed during validation; release stopped before squash.');
  }
  return state;
}

export function releaseCommitMessage({ version, notes }) {
  const [heading, ...body] = notes.trim().split('\n');
  if (heading.trim() !== `# ${version}`)
    throw new Error('Release notes heading differs from package version.');
  if (!body.join('\n').trim()) throw new Error('Release notes must describe the release.');
  return `Release ${version}\n\n${body.join('\n').trim()}\n`;
}

/** Squash reviewed unpublished commits and staged changes without rewriting released history. */
export function commitSquashedRelease({ git, run, base, version, message, expectedState }) {
  assertReleaseState({ git, expected: expectedState });
  const parent = git('rev-parse', `${base}^{commit}`),
    previous = git('rev-parse', 'HEAD');
  // Anything already published after the base must not be rewritten or force-pushed.
  run('git', ['merge-base', '--is-ancestor', 'origin/master', parent]);
  run('git', ['diff', '--cached', '--check']);
  if (previous !== parent) {
    run('git', ['branch', `release-backup/${version}-${Date.now()}`, previous]);
    // Soft reset preserves every staged file and every working-tree byte, including deletions.
    run('git', ['reset', '--soft', parent]);
  }
  try {
    run('git', ['commit', '--file', '-'], { input: message });
  } catch (error) {
    if (previous !== parent) run('git', ['reset', '--soft', previous]);
    throw error;
  }
  return git('rev-parse', 'HEAD');
}
