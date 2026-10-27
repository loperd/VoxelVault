import { geometry, SIDES, type FaceRef, type Finding, type Shape, type Side } from './geometry.ts';
import { entryOf, type BlockEntry, type Mapping } from './mapping.ts';
import { drawn, select, type Assets } from './models.ts';
import type { Schematic } from './schem.ts';
import { AIR, parseState, type BlockState } from './states.ts';
import {
  decodeImage,
  encodeImage,
  firstFrame,
  opaque,
  rotate,
  tint,
  translucent,
  type Image,
} from './textures.ts';
import { compare, ownQuads } from './verify.ts';

/**
 * A schematic → a standard world pack (pack.json, structure.u16, textures/*.png) and a report of
 * every state: exact, approximated (with what) or unsupported (with why), and how many cells each.
 * Pure: bytes in, bytes out. The CLI (cli.ts) reads and writes the files.
 */

/**
 * Tiles of a resource pack by name (`stone_bricks` → assets/minecraft/textures/block/stone_bricks.png),
 * and the reference every state is checked against when there is one (verify.ts). Without it nothing
 * is `exact`: it is `unverified`.
 */
export interface Resources {
  readonly name: string;
  texture(name: string): Uint8Array | undefined;
  readonly models?: Reference;
}
/**
 * The game's blockstates and models, which game they are, and its own tiles. The version is what the
 * reference says of itself (an extracted client jar's version.json: `world_version` is the data
 * version), not its folder's name. Its models are compared only with a schematic of the same data
 * version; for any other, or when either does not say, every aspect is `unverified`.
 */
export interface Reference extends Assets {
  readonly version?: { readonly id: string; readonly dataVersion: number };
  /** The reference's tile of this name, to compare the pixels of the tiles drawn with. */
  texture?(name: string): Uint8Array | undefined;
}

/**
 * Blocks the game tints with one colour wherever they stand (its BlockColors: evergreen and birch
 * foliage, lily pads). Every other tinted block takes its biome's colour.
 */
const FIXED_TINT: Readonly<Record<string, string>> = {
  spruce_leaves: '#619961',
  birch_leaves: '#80a755',
  lily_pad: '#208030',
};
/** Properties the game shows outside the blockstate: the water in a cell, colours by BlockColors. */
const SHOWN_ELSEWHERE: Readonly<Record<string, readonly string[]>> = {
  redstone_wire: ['power'],
  melon_stem: ['age'],
  pumpkin_stem: ['age'],
  attached_melon_stem: [],
  attached_pumpkin_stem: [],
};

export interface Scene {
  readonly markers?: Readonly<Record<string, unknown>>;
  readonly cameras?: Readonly<Record<string, unknown>>;
  readonly environment?: Readonly<Record<string, unknown>>;
  readonly sides?: 'open' | 'closed';
}

export interface ImportOptions {
  readonly id: string;
  readonly version?: string;
  readonly credits?: {
    readonly authors: readonly string[];
    readonly license: string;
    readonly source?: string;
  };
  /** Markers, cameras and environment for the pack; any left out are made from the structure. */
  readonly scene?: Scene;
  /** The schematic was cut to this region (for the report: the cells left out). */
  readonly region?: {
    readonly from: readonly number[];
    readonly to: readonly number[];
    readonly of: readonly [number, number, number];
  };
  /** Pack limit for a tile's side (pack v1: 16). */
  readonly tile?: number;
}

export type Result = 'exact' | 'unverified' | 'approximated' | 'unsupported';
export type Aspect = 'geometry' | 'material' | 'texture' | 'state';
export const ASPECTS: readonly Aspect[] = ['geometry', 'material', 'texture', 'state'];
/**
 * Each aspect on its own: `exact` only when the comparison with the reference shows it; `unverified`
 * when nothing to compare with says either way; `approximated` with a named loss; `unsupported` when
 * not drawn. `geometry`: volume and visible faces against the game's model; `material`: on those
 * faces the tile the model names, its orientation and UV, the tint, and how the tile is drawn
 * (animation, translucency — of the reference's tile when it has one: what the game shows); `texture`:
 * the pixels of the tiles drawn against the reference's own tiles of the same names, and how the
 * given tiles are drawn where they are not those. The contract: with a reference, other images under
 * the same names (any PNGs import) change `texture` only; geometry, material and state against the
 * reference neither improve nor worsen. Without a reference everything is `unverified` anyway.
 */
export type Fidelity = Readonly<Record<Aspect, Result>>;
export interface StateReport {
  readonly state: string;
  /** The spellings the file used for this state (one, unless it named the same state twice). */
  readonly sources: readonly string[];
  readonly cells: number;
  readonly result: Result;
  /** The pack block that draws it (the placeholder for an unsupported state, if the mapping has one). */
  readonly block?: string;
  readonly fidelity: Fidelity;
  readonly findings: readonly Finding[];
  /** What could not be shown either way, by aspect. */
  readonly unverified: Readonly<Partial<Record<Aspect, readonly string[]>>>;
}
export interface ImportReport {
  readonly source: {
    readonly sponge: number;
    readonly dataVersion?: number;
    readonly size: readonly [number, number, number];
  };
  readonly resources: string;
  readonly cells: { readonly total: number; readonly air: number; readonly blocks: number };
  /** The region imported, and how many cells of the whole schematic it leaves out. */
  readonly region?: {
    readonly from: readonly number[];
    readonly to: readonly number[];
    readonly left: number;
  };
  readonly totals: Readonly<Record<Result, { readonly states: number; readonly cells: number }>>;
  /** The same by aspect: how many states and cells each aspect is exact, unverified… for. */
  readonly aspects: Readonly<
    Record<Aspect, Readonly<Record<Result, { readonly states: number; readonly cells: number }>>>
  >;
  /** The reference the states were checked against, if any: what it is, and whether its models were compared. */
  readonly reference?: {
    readonly name: string;
    readonly minecraft?: string;
    readonly dataVersion?: number;
    readonly compared: boolean;
    readonly why?: string;
  };
  readonly states: readonly StateReport[];
  /** Block entities by id: their data (inventories, text) is not imported. */
  readonly blockEntities: Readonly<Record<string, number>>;
  /** Block entities without a place in the schematic (no position, or outside it). */
  readonly strayBlockEntities: number;
  /** Entities by id: none is imported. */
  readonly entities: Readonly<Record<string, number>>;
  readonly textures: readonly string[];
  readonly blocks: number;
  readonly scene: { readonly made: readonly string[] };
}

export interface Imported {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly pack: Record<string, unknown>;
  readonly report: ImportReport;
}

interface Prepared {
  readonly image: Image;
  readonly findings: Finding[];
  readonly clear: boolean;
  readonly tint?: string;
}

/** How blockworld draws a tile short of what it is: the first frame of an animation, translucent pixels solid. */
function drawingLosses(image: Image, name: string, whose: string): Finding[] {
  const findings: Finding[] = [],
    animated = image.height > image.width;
  if (animated)
    findings.push({
      kind: 'approximated',
      aspect: 'material',
      code: 'animation',
      detail: `"${name}"${whose} is animated; its first frame is drawn`,
    });
  const partial = translucent(animated ? firstFrame(image, image.width) : image);
  if (partial)
    findings.push({
      kind: 'approximated',
      aspect: 'material',
      code: 'translucency',
      detail: `"${name}"${whose} has ${partial} translucent pixels; blockworld cuts out or draws solid, so they are drawn solid (a cube of them stops light and hides the faces behind it)`,
    });
  return findings;
}

export function importSchematic(
  schem: Schematic,
  mapping: Mapping,
  resources: Resources,
  options: ImportOptions,
): Imported {
  const tile = options.tile ?? 16,
    [sx, sy, sz] = schem.size;

  // States: one per normalised key, with the cells of every spelling of it.
  const byKey = new Map<
    string,
    {
      state?: BlockState;
      sources: string[];
      cells: number;
      entities: Map<string, number>;
      error?: string;
    }
  >();
  const keyOf: string[] = schem.palette.map((source) => {
    try {
      const s = parseState(source);
      if (!byKey.has(s.key))
        byKey.set(s.key, { state: s, sources: [], cells: 0, entities: new Map() });
      byKey.get(s.key)!.sources.push(source);
      return s.key;
    } catch (error) {
      const key = `?${source}`;
      byKey.set(key, {
        sources: [source],
        cells: 0,
        entities: new Map(),
        error: (error as Error).message,
      });
      return key;
    }
  });
  for (let i = 0; i < schem.blocks.length; i++) byKey.get(keyOf[schem.blocks[i]!]!)!.cells++;
  for (const [cell, id] of schem.blockEntities) {
    const e = byKey.get(keyOf[schem.blocks[cell]!]!)!.entities;
    e.set(id, (e.get(id) ?? 0) + 1);
  }

  // The reference counts only for a schematic of the game it is: the same data version, stated by both.
  const reference = resources.models,
    version = reference?.version;
  const mismatch = !reference
    ? undefined
    : !version
      ? `${reference.name} does not say which game it is (no version.json); its models are not compared`
      : schem.dataVersion === undefined
        ? `the schematic does not give its data version; ${reference.name} is Minecraft ${version.id} (data version ${version.dataVersion}), not compared`
        : schem.dataVersion !== version.dataVersion
          ? `the schematic is data version ${schem.dataVersion}, ${reference.name} is Minecraft ${version.id} (data version ${version.dataVersion}); not compared`
          : undefined;
  const models = mismatch ? undefined : reference;

  // Tiles, each prepared once: read, checked, cut to its first frame, tinted, made opaque where translucent.
  const prepared = new Map<string, Prepared | Finding>();
  const prepare = (name: string): Prepared | Finding => {
    const known = prepared.get(name);
    if (known) return known;
    let out: Prepared | Finding;
    const file = resources.texture(name);
    if (!file)
      out = {
        kind: 'unsupported',
        code: 'texture-missing',
        detail: `${resources.name} has no tile "${name}"`,
      };
    else {
      try {
        let image = decodeImage(file);
        const findings = drawingLosses(image, name, '');
        if (image.width !== tile || image.height % tile !== 0)
          out = {
            kind: 'unsupported',
            code: 'texture-size',
            detail: `tile "${name}" is ${image.width}×${image.height}; a pack takes ${tile}×${tile}`,
          };
        else {
          if (image.height > tile) image = firstFrame(image, tile);
          // Whether the colour is the game's is the block's question (resolve), not the tile's.
          const colour = mapping.tints[name];
          if (colour) image = tint(image, colour);
          if (translucent(image)) image = opaque(image);
          let clear = false;
          for (let i = 3; i < image.rgba.length; i += 4)
            if (image.rgba[i] === 0) {
              clear = true;
              break;
            }
          out = { image, findings, clear, ...(colour ? { tint: colour } : {}) };
        }
      } catch (error) {
        out = {
          kind: 'unsupported',
          code: 'texture-format',
          detail: `tile "${name}" could not be read: ${(error as Error).message}`,
        };
      }
    }
    prepared.set(name, out);
    return out;
  };

  // The pack's own tiles: a resource tile, turned when a face needs it (name-r1…r3).
  const packTextures = new Map<string, Image>(),
    sourceOf = new Map<string, { name: string; quarters: number; tint?: string }>();
  const packTile = (name: string, quarters: number): string => {
    const p = prepared.get(name) as Prepared,
      base = name.replaceAll('/', '_'),
      own = quarters ? `${base}-r${quarters}` : base;
    if (!packTextures.has(own)) {
      packTextures.set(own, rotate(p.image, quarters));
      sourceOf.set(own, { name, quarters, ...(p.tint ? { tint: p.tint } : {}) });
    }
    return own;
  };

  const blocks: Record<string, unknown>[] = [],
    ids = new Map<string, number>(),
    names = new Set<string>();
  const nameFor = (state: BlockState) => {
    let base = state.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 56),
      name = base,
      n = 1;
    while (names.has(name)) name = `${base}-${++n}`;
    names.add(name);
    return name;
  };
  let placeholder: number | undefined;
  const states: StateReport[] = [];
  const compared = new Map<string, true | { kind: 'unverified' | 'approximated'; why: string }>(),
    referenceLosses = new Map<string, Finding[] | undefined>();

  for (const [key, s] of [...byKey].sort(
    (a, b) => b[1].cells - a[1].cells || (a[0] < b[0] ? -1 : 1),
  )) {
    if (!s.cells) continue;
    const state = s.state;
    if (state && AIR.has(state.name)) continue;
    const findings: Finding[] = [],
      unverified: Partial<Record<Aspect, string[]>> = {};
    const doubt = (aspect: Aspect, why: string) => {
      (unverified[aspect] ??= []).push(why);
    };
    let definition: Record<string, unknown> | undefined;
    const settle = (): void => {
      const unsupported = findings.some((f) => f.kind === 'unsupported');
      let block: string | undefined;
      if (!unsupported && definition) {
        blocks.push(definition);
        ids.set(key, blocks.length);
        block = definition.name as string;
      } else if (mapping.placeholder) {
        placeholder ??= makePlaceholder();
        if (placeholder) {
          ids.set(key, placeholder);
          block = 'placeholder';
        }
      }
      // One finding per code and detail.
      const unique = findings.filter(
        (f, i) => findings.findIndex((g) => g.code === f.code && g.detail === f.detail) === i,
      );
      const of = (aspect: Aspect): Result => {
        if (unsupported) return 'unsupported';
        const lost = unique.some(
          (f) =>
            f.kind === 'approximated' &&
            (aspect === 'geometry'
              ? f.aspect === 'shape'
              : aspect === 'state'
                ? f.aspect === 'state' || f.aspect === 'block-entity'
                : f.aspect === aspect),
        );
        return lost ? 'approximated' : unverified[aspect]?.length ? 'unverified' : 'exact';
      };
      const fidelity = {
        geometry: of('geometry'),
        material: of('material'),
        texture: of('texture'),
        state: of('state'),
      };
      const rank: Result[] = ['exact', 'unverified', 'approximated', 'unsupported'];
      const result = ASPECTS.map((a) => fidelity[a]).reduce(
        (worst, r) => (rank.indexOf(r) > rank.indexOf(worst) ? r : worst),
        'exact' as Result,
      );
      const doubts = Object.fromEntries(
        Object.entries(unverified).map(([a, list]) => [a, [...new Set(list)]]),
      );
      states.push({
        state: state?.key ?? key.slice(1),
        sources: s.sources,
        cells: s.cells,
        result,
        ...(block ? { block } : {}),
        fidelity,
        findings: unique,
        unverified: doubts,
      });
    };
    if (!state) {
      findings.push({ kind: 'unsupported', code: 'bad-state', detail: s.error! });
      settle();
      continue;
    }

    const found = entryOf(mapping, state.name);
    if (!found) {
      findings.push({
        kind: 'unsupported',
        code: 'no-mapping',
        detail: `the mapping names no tiles for ${state.name}`,
      });
      settle();
      continue;
    }
    const { entry } = found;
    const g = geometry(state, {
      ...(entry.shape ? { shape: entry.shape } : {}),
      ...(entry.front ? { front: true } : {}),
    });
    findings.push(...g.findings);
    if (!g.shape) {
      settle();
      continue;
    }
    if (entry.approximate)
      findings.push({
        kind: 'approximated',
        aspect: 'material',
        code: 'stand-in',
        detail: entry.approximate,
      });
    for (const [id, n] of s.entities)
      findings.push({
        kind: 'approximated',
        aspect: 'block-entity',
        code: 'block-entity',
        detail: `${n} ${id} block entit${n === 1 ? 'y' : 'ies'}: their data (inventory, text) is not imported`,
      });
    definition = define(nameFor(state), g.shape, entry, findings, state.name);
    if (definition) check(state, definition, g.unread, findings, doubt);
    else if (g.unread.length) doubt('state', `not drawn: ${g.unread.join(', ')}`);
    settle();
  }

  /**
   * The block against the reference's blockstate, model and tiles, when there is a reference of the
   * schematic's game: a finding for every difference; without one every aspect stays unverified.
   */
  function check(
    state: BlockState,
    definition: Record<string, unknown>,
    unread: readonly string[],
    findings: Finding[],
    doubt: (aspect: Aspect, why: string) => void,
  ): void {
    const water = state.props.waterlogged === 'true';
    if (water)
      findings.push({
        kind: 'approximated',
        aspect: 'state',
        code: 'waterlogged',
        detail: 'the water in the cell is not drawn',
      });
    for (const k of SHOWN_ELSEWHERE[state.name] ?? [])
      if (k in state.props)
        findings.push({
          kind: 'approximated',
          aspect: 'state',
          code: 'colour-property',
          detail: `${k}=${state.props[k]} colours the block in the game; not drawn`,
        });
    const assets = models;
    if (assets) pixels(definition, findings, doubt);
    else doubt('texture', mismatch ?? 'no reference tiles to compare with');
    const selection = assets ? select(state, assets) : undefined;
    if (!assets || !selection) {
      const why =
        mismatch ??
        (assets
          ? `${assets.name} has no blockstate for ${state.name}`
          : 'no blockstates or models to compare with');
      for (const aspect of ['geometry', 'material', 'state'] as const) doubt(aspect, why);
      const unknown = unread.filter((k) => k !== 'waterlogged');
      if (unknown.length)
        doubt(
          'state',
          `not drawn, not known to be invisible: ${unknown.map((k) => `${k}=${state.props[k]}`).join(', ')}`,
        );
      return;
    }
    const own = ownQuads({ definition, source: (tile) => sourceOf.get(tile)! });
    let verdict;
    try {
      verdict = own ? compare(own, drawn(selection, assets)) : undefined;
    } catch (error) {
      doubt('geometry', (error as Error).message);
      doubt('material', (error as Error).message);
      return;
    }
    if (!verdict) {
      doubt(
        'geometry',
        `a ${definition.model} model is drawn by blockworld's own rule, not compared`,
      );
      doubt('material', `a ${definition.model} model is not compared`);
    } else {
      findings.push(...verdict.shape, ...verdict.material);
      verdict.unverified.shape.forEach((w) => doubt('geometry', w));
      verdict.unverified.material.forEach((w) => doubt('material', w));
    }
    // A property the blockstate does not read leaves the model as it is; one it reads is shown by the comparison.
    const shown =
      verdict &&
      !verdict.shape.length &&
      !verdict.material.length &&
      !verdict.unverified.shape.length &&
      !verdict.unverified.material.length;
    // One it reads but the shape was not made from is drawn right exactly when this state's model matches.
    const read = unread.filter((k) => selection.props.has(k));
    if (read.length && !shown)
      doubt(
        'state',
        `${read.map((k) => `${k}=${state.props[k]}`).join(', ')} picks the game's model, the shape is not made from it, and the model differs for other reasons`,
      );
  }

  /** The tiles a block draws against the reference's tiles of the same names, pixel by pixel (every frame). */
  function pixels(
    definition: Record<string, unknown>,
    findings: Finding[],
    doubt: (aspect: Aspect, why: string) => void,
  ): void {
    const own = [
      ...Object.values(definition.textures as Record<string, string>),
      ...(
        (definition.parts as { faces?: Record<string, { texture?: string }> }[] | undefined) ?? []
      ).flatMap((p) => Object.values(p.faces ?? {}).flatMap((f) => (f.texture ? [f.texture] : []))),
    ];
    for (const name of new Set(own.map((t) => sourceOf.get(t)!.name))) {
      const verdict = sameAsReference(name);
      if (verdict === true) continue;
      if (verdict.kind === 'unverified') doubt('texture', verdict.why);
      else
        findings.push({
          kind: 'approximated',
          aspect: 'texture',
          code: 'texture-differs',
          detail: verdict.why,
        });
    }
  }
  function sameAsReference(
    name: string,
  ): true | { kind: 'unverified' | 'approximated'; why: string } {
    const known = compared.get(name);
    if (known) return known;
    let out: true | { kind: 'unverified' | 'approximated'; why: string };
    const theirs = models!.texture?.(name),
      mine = resources.texture(name)!;
    if (!models!.texture)
      out = { kind: 'unverified', why: `${models!.name} has no tiles to compare the pixels with` };
    else if (!theirs) out = { kind: 'unverified', why: `${models!.name} has no tile "${name}"` };
    else {
      try {
        const a = decodeImage(mine),
          b = decodeImage(theirs);
        if (a.width !== b.width || a.height !== b.height)
          out = {
            kind: 'approximated',
            why: `"${name}" is ${a.width}×${a.height}, the reference's ${b.width}×${b.height}`,
          };
        else {
          let differ = 0;
          for (let i = 0; i < a.rgba.length; i += 4)
            if (
              a.rgba[i] !== b.rgba[i] ||
              a.rgba[i + 1] !== b.rgba[i + 1] ||
              a.rgba[i + 2] !== b.rgba[i + 2] ||
              a.rgba[i + 3] !== b.rgba[i + 3]
            )
              differ++;
          out = differ
            ? {
                kind: 'approximated',
                why: `"${name}" is not the reference's tile: ${differ} of ${a.rgba.length / 4} pixels differ`,
              }
            : true;
        }
      } catch (error) {
        out = {
          kind: 'unverified',
          why: `the reference's tile "${name}" could not be read: ${(error as Error).message}`,
        };
      }
    }
    compared.set(name, out);
    return out;
  }

  /**
   * How a tile is drawn, as material findings. With a reference that has the tile, judged by the
   * reference's tile — what the game shows — so other pixels make no block's material better or worse;
   * the given tile's own losses then belong to `texture`, and only where it is not the reference's tile.
   */
  function drawing(name: string, p: Prepared): Finding[] {
    if (!referenceLosses.has(name)) {
      const theirs = models?.texture?.(name);
      let losses: Finding[] | undefined;
      try {
        losses = theirs
          ? drawingLosses(decodeImage(theirs), name, ` (in ${models!.name})`)
          : undefined;
      } catch {
        losses = undefined;
      }
      referenceLosses.set(name, losses);
    }
    const reference = referenceLosses.get(name);
    if (!reference) return p.findings;
    const own =
      sameAsReference(name) === true
        ? []
        : p.findings.map((f) => ({
            ...f,
            aspect: 'texture' as const,
            detail: `the tile given: ${f.detail}`,
          }));
    return [...reference, ...own];
  }

  function resolve(
    face: FaceRef,
    entry: BlockEntry,
    side: string,
    findings: Finding[],
    block: string,
  ): { tile: string; clear: boolean } | undefined {
    const role = face.roles.find((r) => entry.textures[r] !== undefined);
    if (!role) {
      findings.push({
        kind: 'unsupported',
        code: 'no-role',
        detail: `the mapping gives no tile for its ${side} side (any of ${face.roles.join(', ')})`,
      });
      return undefined;
    }
    const p = prepare(entry.textures[role]!);
    if ('kind' in p) {
      findings.push(p);
      return undefined;
    }
    findings.push(...drawing(entry.textures[role]!, p));
    if (p.tint && FIXED_TINT[block] !== p.tint) {
      findings.push({
        kind: 'approximated',
        aspect: 'material',
        code: 'biome-tint',
        detail: FIXED_TINT[block]
          ? `"${entry.textures[role]}" tinted ${p.tint}; the game tints ${block} ${FIXED_TINT[block]} everywhere`
          : `"${entry.textures[role]}" tinted ${p.tint}: the game tints ${block} by its biome, which the schematic does not give`,
      });
    }
    return { tile: packTile(entry.textures[role]!, face.quarters), clear: p.clear };
  }

  function define(
    name: string,
    shape: Shape,
    entry: BlockEntry,
    findings: Finding[],
    block: string,
  ): Record<string, unknown> | undefined {
    let clear = false;
    const light = entry.light ? { light: entry.light } : {};
    if (shape.kind === 'cross' || shape.kind === 'torch') {
      const t = resolve({ roles: shape.roles, quarters: 0 }, entry, 'only', findings, block);
      if (!t) return undefined;
      return { name, model: shape.kind, textures: { all: t.tile }, ...light };
    }
    const box: Extract<Shape, { faces: unknown }> = shape,
      textures: Partial<Record<Side, string>> = {};
    for (const side of SIDES) {
      const t = resolve(box.faces[side], entry, side, findings, block);
      if (!t) return undefined;
      textures[side] = t.tile;
      clear ||= t.clear;
    }
    if (box.kind === 'cube')
      return { name, textures, ...(clear ? { transparent: true, cutout: true } : {}), ...light };
    const parts = [];
    for (const part of box.parts) {
      const faces: Record<string, unknown> = {};
      for (const [side, face] of Object.entries(part.faces ?? {}) as [Side, FaceRef][]) {
        const t = resolve(face, entry, side, findings, block);
        if (!t) return undefined;
        clear ||= t.clear;
        if (t.tile !== textures[side] || face.uv)
          faces[side] = {
            ...(t.tile !== textures[side] ? { texture: t.tile } : {}),
            ...(face.uv ? { uv: face.uv } : {}),
          };
      }
      parts.push({ from: part.from, to: part.to, ...(Object.keys(faces).length ? { faces } : {}) });
    }
    return { name, model: 'parts', textures, parts, ...(clear ? { cutout: true } : {}), ...light };
  }

  function makePlaceholder(): number | undefined {
    const p = prepare(mapping.placeholder!);
    if ('kind' in p) return undefined;
    blocks.push({ name: 'placeholder', textures: { all: packTile(mapping.placeholder!, 0) } });
    return blocks.length;
  }

  // The structure, in the pack's order (x fastest, then y, then z); the schematic's is x, z, y.
  const cells = new Uint8Array(2 * sx * sy * sz),
    view = new DataView(cells.buffer),
    solid: boolean[] = [];
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const id = ids.get(keyOf[schem.blocks[x + sx * (z + sz * y)]!]!) ?? 0,
          i = x + sx * (y + sy * z);
        view.setUint16(2 * i, id, true);
        solid[i] = id > 0 && !blocks[id - 1]!.model && !blocks[id - 1]!.cutout;
      }

  const { scene, made } = sceneOf(
    options.scene ?? {},
    [sx, sy, sz],
    (x, y, z) => solid[x + sx * (y + sy * z)] === true,
    (x, y, z) => view.getUint16(2 * (x + sx * (y + sy * z)), true) === 0,
  );
  const files = new Map<string, Uint8Array>();
  const textures: Record<string, string> = {};
  for (const [name, image] of [...packTextures].sort(([a], [b]) => (a < b ? -1 : 1))) {
    textures[name] = `textures/${name}.png`;
    files.set(textures[name]!, encodeImage(image));
  }
  files.set('structure.u16', cells);
  const pack = {
    format: 1,
    id: options.id,
    version: options.version ?? '1.0.0',
    requires: { blockworld: 1 },
    ...(options.credits ? { credits: options.credits } : {}),
    textures,
    blocks,
    structure: {
      size: [sx, sy, sz],
      origin: [-Math.floor(sx / 2), 0, -Math.floor(sz / 2)],
      sides: options.scene?.sides ?? 'open',
      cells: 'structure.u16',
    },
    markers: scene.markers,
    cameras: scene.cameras,
    environment: scene.environment,
  };
  files.set('pack.json', new TextEncoder().encode(`${JSON.stringify(pack, null, 1)}\n`));

  const zero = () => ({
    exact: { states: 0, cells: 0 },
    unverified: { states: 0, cells: 0 },
    approximated: { states: 0, cells: 0 },
    unsupported: { states: 0, cells: 0 },
  });
  const totals = zero(),
    aspects = { geometry: zero(), material: zero(), texture: zero(), state: zero() };
  for (const s of states) {
    totals[s.result].states++;
    totals[s.result].cells += s.cells;
    for (const a of ASPECTS) {
      aspects[a][s.fidelity[a]].states++;
      aspects[a][s.fidelity[a]].cells += s.cells;
    }
  }
  const air = [...byKey.values()]
    .filter((s) => s.state && AIR.has(s.state.name))
    .reduce((n, s) => n + s.cells, 0);
  const report: ImportReport = {
    source: {
      sponge: schem.version,
      ...(schem.dataVersion !== undefined ? { dataVersion: schem.dataVersion } : {}),
      size: schem.size,
    },
    resources: resources.name,
    cells: { total: schem.blocks.length, air, blocks: schem.blocks.length - air },
    ...(options.region
      ? {
          region: {
            from: options.region.from,
            to: options.region.to,
            left: options.region.of.reduce((a, b) => a * b, 1) - schem.blocks.length,
          },
        }
      : {}),
    totals,
    aspects,
    states,
    ...(reference
      ? {
          reference: {
            name: reference.name,
            ...(version ? { minecraft: version.id, dataVersion: version.dataVersion } : {}),
            compared: !mismatch,
            ...(mismatch ? { why: mismatch } : {}),
          },
        }
      : {}),
    blockEntities: Object.fromEntries(
      [...schem.blockEntities.values()].reduce(
        (m, id) => m.set(id, (m.get(id) ?? 0) + 1),
        new Map<string, number>(),
      ),
    ),
    strayBlockEntities: schem.strayBlockEntities,
    entities: Object.fromEntries(schem.entities),
    textures: Object.keys(textures),
    blocks: blocks.length,
    scene: { made },
  };
  return { files, pack, report };
}

/**
 * Markers, cameras and environment the author did not give: a guest marker on the standable top
 * nearest the middle, a close camera on it and an overview, open daylight.
 */
function sceneOf(
  given: Scene,
  [sx, sy, sz]: readonly [number, number, number],
  solid: (x: number, y: number, z: number) => boolean,
  air: (x: number, y: number, z: number) => boolean,
) {
  const made: string[] = [];
  let markers = given.markers;
  if (!markers) {
    let best: [number, number, number] | undefined,
      distance = Infinity;
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        let y = sy - 1;
        while (y >= 0 && air(x, y, z)) y--;
        if (
          y < 0 ||
          !solid(x, y, z) ||
          (y + 1 < sy && !air(x, y + 1, z)) ||
          (y + 2 < sy && !air(x, y + 2, z))
        )
          continue;
        const d = (x + 0.5 - sx / 2) ** 2 + (z + 0.5 - sz / 2) ** 2;
        if (d < distance) {
          distance = d;
          best = [x + 0.5, y + 1, z + 0.5];
        }
      }
    markers = { guest: { at: best ?? [sx / 2, sy, sz / 2], front: 'south', tags: ['guest'] } };
    made.push('markers');
  }
  let cameras = given.cameras;
  if (!cameras) {
    const r = Math.max(sx, sy, sz),
      guest = Object.entries(markers).find(([, m]) =>
        ((m as { tags?: string[] }).tags ?? []).includes('guest'),
      );
    const at = (guest?.[1] as { at?: number[] } | undefined)?.at ?? [sx / 2, sy / 2, sz / 2];
    const round = (v: number) => Math.round(v * 100) / 100;
    cameras = {
      overview: {
        eye: [round(sx / 2 + r * 0.8), round(sy * 0.5 + r * 0.6), round(sz / 2 + r * 1.1)],
        look: [round(sx / 2), round(sy * 0.35), round(sz / 2)],
        fov: 50,
        drift: 0,
      },
      ...(guest
        ? {
            hero: {
              eye: [round(at[0]!), round(at[1]! + 2.2), round(at[2]! + 5.5)],
              look: guest[0],
              fov: 50,
              focus: [0.5, 0.48],
              drift: 0.1,
            },
          }
        : {}),
    };
    made.push('cameras');
  }
  let environment = given.environment;
  if (!environment) {
    environment = {
      sky: { top: '#3d6fb8', horizon: '#a9c6e8', bottom: '#5d6b74' },
      fog: { color: '#a9c6e8', near: Math.max(sx, sz) * 1.5, far: Math.max(sx, sz) * 5 },
      blocks: { sky: [1, 1, 1], glow: [1, 0.82, 0.6], minimum: 0.08, occlusion: 0.6 },
      sun: { direction: [-0.45, 0.75, 0.5], color: '#fff1d6', strength: 0.35, scatter: 0.6 },
      light: {
        sky: '#c4d6f0',
        ground: '#6b5a48',
        key: '#fff1d6',
        objects: { key: 1.6, fill: 0.9 },
        guest: { key: 4, fill: 1.6 },
      },
    };
    made.push('environment');
  }
  return { scene: { markers, cameras, environment }, made };
}
