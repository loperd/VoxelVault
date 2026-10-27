/**
 * The author's resource mapping (`mapping.json`): which tiles of a resource pack a block uses. The
 * importer has no tiles of its own and never falls back to one: a block not named here is reported
 * unsupported, a tile the resource pack lacks too.
 *
 * {
 *   "format": 1,
 *   "blocks": {                                     block name (no namespace) → its tiles and traits
 *     "grass_block": { "textures": { "top": "grass_block_top", "side": "grass_block_side", "bottom": "dirt" } },
 *     "spruce_log": { "textures": { "end": "spruce_log_top", "side": "spruce_log" } },
 *     "lantern": { "textures": { "all": "lantern" }, "light": 15 },
 *     "dandelion": { "textures": { "all": "dandelion" }, "shape": "cross" },
 *     "furnace": { "textures": { "front": "furnace_front", "side": "furnace_side", "top": "furnace_top" }, "front": true },
 *     "crying_obsidian": { "textures": { "all": "obsidian" }, "approximate": "no crying_obsidian tile: obsidian" }
 *   },
 *   "materials": { "stone_brick": "stone_bricks" },  stairs/slab/wall/fence material → block above
 *   "tints": { "grass_block_top": "#91bd59" },       grey tiles the game tints by biome: a fixed tint
 *   "placeholder": "missing"                          optional tile drawn where a block is unsupported
 * }
 *
 * Roles: `all`; `top`/`bottom`/`side`; `end` (both ends of a pillar); per side `north`…`down`;
 * `front`; `top_open` (an open barrel). A side takes the first role the block gives (geometry.ts).
 */
export interface BlockEntry {
  readonly textures: Readonly<Record<string, string>>;
  readonly shape?: 'cube' | 'cross' | 'torch';
  readonly front?: boolean;
  readonly light?: number;
  /** The author's own stand-in, reported as an approximated material with this text. */
  readonly approximate?: string;
}

export interface Mapping {
  readonly format: 1;
  readonly blocks: Readonly<Record<string, BlockEntry>>;
  readonly materials: Readonly<Record<string, string>>;
  readonly tints: Readonly<Record<string, string>>;
  readonly placeholder?: string;
}

const ROLES = new Set([
  'all',
  'top',
  'bottom',
  'side',
  'end',
  'north',
  'south',
  'east',
  'west',
  'up',
  'down',
  'front',
  'top_open',
]);
const TILE = /^[a-z0-9_]+(?:\/[a-z0-9_]+)*$/;

/** Checks a parsed mapping.json; every problem in one error. */
export function readMapping(json: unknown): Mapping {
  const problems: string[] = [];
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const only = (o: Record<string, unknown>, path: string, keys: readonly string[]) => {
    for (const k of Object.keys(o))
      if (!keys.includes(k)) problems.push(`${path}.${k}: unknown key`);
  };
  if (!isObject(json)) throw new Error('mapping: not an object');
  only(json, 'mapping', ['format', 'blocks', 'materials', 'tints', 'placeholder']);
  if (json.format !== 1) problems.push('mapping.format: must be 1');
  const blocks: Record<string, BlockEntry> = {};
  if (!isObject(json.blocks)) problems.push('mapping.blocks: an object of blocks');
  for (const [name, e] of Object.entries(isObject(json.blocks) ? json.blocks : {})) {
    const path = `mapping.blocks.${name}`;
    if (!isObject(e)) {
      problems.push(`${path}: an object`);
      continue;
    }
    only(e, path, ['textures', 'shape', 'front', 'light', 'approximate']);
    if (!isObject(e.textures) || !Object.keys(e.textures).length)
      problems.push(`${path}.textures: at least one role`);
    for (const [role, tile] of Object.entries(isObject(e.textures) ? e.textures : {})) {
      if (!ROLES.has(role)) problems.push(`${path}.textures.${role}: not a role`);
      if (typeof tile !== 'string' || !TILE.test(tile))
        problems.push(`${path}.textures.${role}: not a tile name`);
    }
    if (e.shape !== undefined && !['cube', 'cross', 'torch'].includes(e.shape as string))
      problems.push(`${path}.shape: cube, cross or torch`);
    if (e.front !== undefined && typeof e.front !== 'boolean')
      problems.push(`${path}.front: true or false`);
    if (
      e.light !== undefined &&
      !(Number.isInteger(e.light) && (e.light as number) >= 0 && (e.light as number) <= 15)
    )
      problems.push(`${path}.light: 0..15`);
    if (e.approximate !== undefined && (typeof e.approximate !== 'string' || !e.approximate))
      problems.push(`${path}.approximate: a description`);
    blocks[name] = e as unknown as BlockEntry;
  }
  const strings = (
    v: unknown,
    path: string,
    test: (s: string) => boolean,
    what: string,
  ): Record<string, string> => {
    if (v === undefined) return {};
    if (!isObject(v)) {
      problems.push(`${path}: an object`);
      return {};
    }
    for (const [k, s] of Object.entries(v))
      if (typeof s !== 'string' || !test(s)) problems.push(`${path}.${k}: ${what}`);
    return v as Record<string, string>;
  };
  const materials = strings(
    json.materials,
    'mapping.materials',
    (s) => s in blocks,
    'a block of mapping.blocks',
  );
  const tints = strings(
    json.tints,
    'mapping.tints',
    (s) => /^#[0-9a-f]{6}$/i.test(s),
    'a colour #rrggbb',
  );
  if (
    json.placeholder !== undefined &&
    (typeof json.placeholder !== 'string' || !TILE.test(json.placeholder))
  )
    problems.push('mapping.placeholder: a tile name');
  if (problems.length) throw new Error(`mapping is not valid:\n  ${problems.join('\n  ')}`);
  return {
    format: 1,
    blocks,
    materials,
    tints,
    ...(json.placeholder ? { placeholder: json.placeholder as string } : {}),
  };
}

const FAMILIES = ['_stairs', '_slab', '_wall', '_fence'];

/**
 * A block's entry: its own, or for stairs, slabs, walls and fences their material's — by the
 * mapping's `materials`, else by the game's naming (`stone_brick_stairs` → `stone_bricks`,
 * `spruce_slab` → `spruce_planks`). Undefined when the mapping names neither.
 */
export function entryOf(
  mapping: Mapping,
  name: string,
): { readonly entry: BlockEntry; readonly via?: string } | undefined {
  const own = mapping.blocks[name];
  if (own) return { entry: own };
  const suffix = FAMILIES.find((s) => name.endsWith(s));
  if (!suffix) return undefined;
  const base = name.slice(0, -suffix.length);
  for (const candidate of [mapping.materials[base], base, `${base}s`, `${base}_planks`]) {
    if (candidate && mapping.blocks[candidate])
      return { entry: mapping.blocks[candidate]!, via: candidate };
  }
  return undefined;
}
