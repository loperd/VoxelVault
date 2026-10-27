import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { requestBlender } from '../../scripts/blender/client.mjs';

async function receive(directory) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const files = await readdir(join(directory, 'requests')).catch(() => []);
    const file = files.find((file) => file.endsWith('.json'));
    if (file)
      return {
        file,
        request: JSON.parse(await readFile(join(directory, 'requests', file), 'utf8')),
      };
    await setTimeout(10);
  }
  throw new Error('No queued request.');
}

test('Blender client exchanges a complete job/result with the mailbox protocol', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcroulette-blender-test-'));
  try {
    const promise = requestBlender('status', undefined, { directory, timeout: 2000 });
    const { file, request } = await receive(directory);
    assert.equal(request.action, 'status');
    assert.ok(request.expiresAt * 1000 > Date.now());
    await mkdir(join(directory, 'results'), { recursive: true });
    await writeFile(
      join(directory, 'results', file),
      JSON.stringify({ ok: true, result: { scene: 'Workbench', objects: [] } }),
    );
    assert.deepEqual(await promise, { scene: 'Workbench', objects: [] });
    assert.deepEqual(await readdir(join(directory, 'results')), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Blender operation failures reach the client and a timed-out pending job is removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcroulette-blender-test-'));
  try {
    const promise = requestBlender('import', 'assets/missing.glb', { directory, timeout: 2000 });
    const failed = assert.rejects(promise, /File not found/);
    const { file } = await receive(directory);
    await writeFile(
      join(directory, 'results', file),
      JSON.stringify({ ok: false, error: 'File not found' }),
    );
    await failed;
    // The simulated worker consumes its own input; the next test has only the new pending request.
    await rm(join(directory, 'requests', file));
    await assert.rejects(
      requestBlender('status', undefined, { directory, timeout: 120 }),
      /did not reply/,
    );
    assert.deepEqual(await readdir(join(directory, 'requests')), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid Blender commands never create a job', async () => {
  await assert.rejects(requestBlender('delete-everything'), /Unknown/);
  await assert.rejects(requestBlender('exec'), /requires/);
  await assert.rejects(requestBlender('status', undefined, { timeout: NaN }), /positive/);
});
