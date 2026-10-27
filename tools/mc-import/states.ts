/**
 * Block states, normalised: the name without the `minecraft:` namespace, properties kept as the file
 * gives them (none dropped, none invented), in alphabetical order. `key` is the canonical form, so
 * the same state spelled two ways is one state.
 */
export interface BlockState {
  /** As the file names it. */
  readonly source: string;
  readonly namespace: string;
  readonly name: string;
  readonly props: Readonly<Record<string, string>>;
  /** `name[k=v,…]` with the properties sorted; `name` alone without properties. */
  readonly key: string;
}

const STATE = /^(?:([a-z0-9_.-]+):)?([a-z0-9_./-]+)(?:\[([^\]]*)\])?$/;

export function parseState(source: string): BlockState {
  const m = STATE.exec(source.trim());
  if (!m) throw new Error(`Not a block state: "${source}".`);
  const [, namespace = 'minecraft', name = '', list = ''] = m;
  const props: Record<string, string> = {};
  for (const pair of list ? list.split(',') : []) {
    const [k, v, extra] = pair.split('=').map((s) => s.trim());
    if (
      !k ||
      v === undefined ||
      extra !== undefined ||
      !/^[a-z0-9_]+$/.test(k) ||
      !/^[a-z0-9_]+$/.test(v)
    )
      throw new Error(`Not a block state: "${source}" (property "${pair}").`);
    if (k in props) throw new Error(`Not a block state: "${source}" (property "${k}" twice).`);
    props[k] = v;
  }
  const sorted = Object.fromEntries(Object.entries(props).sort(([a], [b]) => (a < b ? -1 : 1)));
  const listed = Object.entries(sorted)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  const qualified = namespace === 'minecraft' ? name : `${namespace}:${name}`;
  return Object.freeze({
    source,
    namespace,
    name: qualified,
    props: Object.freeze(sorted),
    key: listed ? `${qualified}[${listed}]` : qualified,
  });
}

export const AIR = new Set(['air', 'cave_air', 'void_air']);
