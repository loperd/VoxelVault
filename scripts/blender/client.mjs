import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

export const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function requestBlender(
  action,
  path,
  { timeout = 15000, directory = resolve(project, '.blender') } = {},
) {
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error('BLENDER_TIMEOUT_MS must be positive.');
  if (!['status', 'exec', 'import', 'save', 'export', 'render'].includes(action))
    throw new Error('Unknown Blender action.');
  if (action !== 'status' && !path) throw new Error(`${action} requires a project file path.`);
  const id = randomUUID(),
    requests = resolve(directory, 'requests'),
    results = resolve(directory, 'results');
  await mkdir(requests, { recursive: true });
  await mkdir(results, { recursive: true });
  const queued = resolve(requests, `${id}.json`),
    output = resolve(results, `${id}.json`);
  const expiresAt = Date.now() + timeout;
  await writeFile(`${queued}.tmp`, JSON.stringify({ action, path, expiresAt: expiresAt / 1000 }));
  await rename(`${queued}.tmp`, queued);
  while (Date.now() < expiresAt) {
    try {
      const response = JSON.parse(await readFile(output, 'utf8'));
      await unlink(output);
      if (!response.ok) throw new Error(response.error);
      return response.result;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await setTimeout(100);
  }
  await unlink(queued).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  throw new Error(
    `Blender did not reply (request ${id}). Start scripts/blender/bridge.py in Blender. An already running operation may still finish; do not resubmit it blindly.`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await requestBlender(process.argv[2] ?? 'status', process.argv[3], {
      timeout: Number(process.env.BLENDER_TIMEOUT_MS ?? 15000),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
