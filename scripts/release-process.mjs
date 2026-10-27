import { spawnSync } from 'node:child_process';

/** Run a release command, piping an explicitly supplied input to its stdin. */
export function runReleaseCommand(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  const stdio = options.input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'];
  const result = spawnSync(command, args, { stdio, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status ?? result.signal}); release stopped.`);
  return result.stdout?.trim();
}
