import { DomainError } from './error.ts';

/**
 * Per-model modification profile. The server owns and configures it; the client only validates
 * and draws. Each model declares its own parts, colour zones and catalogue of modifications with
 * a rendering style; instances reference catalogue entries by id (see chest-appearance.ts).
 */
export const PALETTE_ROLES = ['shell', 'panel', 'metal', 'accent'] as const;
export type PaletteRole = (typeof PALETTE_ROLES)[number];
export const MODIFICATION_KINDS = ['fracture', 'wear', 'glow', 'growth'] as const;
export type ModificationKind = (typeof MODIFICATION_KINDS)[number];

export interface ChestPart {
  readonly id: string;
  readonly label: string;
  readonly nodes: readonly string[];
  /** Hangs from its top edge and swings when the chest is jolted (a latch, a padlock). */
  readonly swing?: boolean;
}
/** replace: set the material colour (neutral textures); tint: blend a light version over a coloured texture. */
export interface ColorZone {
  readonly role: PaletteRole;
  readonly mode: 'replace' | 'tint';
  readonly strength: number;
  readonly materials: readonly string[];
  readonly nodes: readonly string[];
}
export interface FractureStyle {
  readonly branches: number;
  readonly minLength: number;
  readonly maxLength: number;
  readonly drift: number;
  readonly scarColor: string;
  readonly scale: number;
}
export interface WearStyle {
  readonly color: string;
  readonly spots: number;
  readonly minRadius: number;
  readonly maxRadius: number;
  readonly scratches: number;
  readonly scale: number;
  /** Optional ageing colour: later spots shift towards it (copper-like oxidation stages). */
  readonly colorEnd?: string;
  /** Where wear concentrates; edges = rubbed corners and rims. */
  readonly anchor: 'top' | 'bottom' | 'edges' | 'all';
  /** Rubbed stone is translucent over the base (low), rust is a solid crust (high). */
  readonly opacity: number;
}
export interface GlowStyle {
  readonly pattern: 'runes' | 'veins' | 'sparks';
  readonly density: number;
  readonly scale: number;
  /** Omitted colour follows the instance accent. */
  readonly color?: string;
  readonly pulse: number;
  /** 0 = dark carved symbols only, 1 = fully lit. Engraved, not neon: light stays inside the groove. */
  readonly brightness: number;
}
export const GROWTH_TYPES = [
  'moss',
  'frost',
  'lichen',
  'blight',
  'crystals',
  'vines',
  'cobweb',
  'snow',
] as const;
/** Surface types are drawn as overlays; crystals, vines, cobweb and snow add small geometry. */
export interface GrowthStyle {
  readonly type: (typeof GROWTH_TYPES)[number];
  readonly color: string;
  readonly scale: number;
  /** Where a surface growth starts: top (snow-like), bottom (damp), edges (seams and corners) or all. */
  readonly anchor: 'top' | 'bottom' | 'edges' | 'all';
  /** Sparse accent pixels (lichen dots, blight sensors). */
  readonly highlight?: string;
  /** Faint self-light of the growth, 0..1. */
  readonly glow: number;
  /** 0 = only upward faces, 1 = every face. */
  readonly spread: number;
  readonly count: number;
  /** Coverage opacity of moss/frost over the base texture. */
  readonly opacity: number;
}
export const DEBRIS_SHAPES = ['chip', 'shard', 'leaf', 'flake', 'spark', 'puff'] as const;
/** What breaking a part carrying this modification throws off: rust flakes, moss clumps, ice shards… */
export interface DebrisStyle {
  readonly shape: (typeof DEBRIS_SHAPES)[number];
  readonly color: string;
  readonly share: number;
}
interface DefinitionBase {
  readonly id: string;
  readonly label: string;
  readonly parts: readonly string[];
  /** Server-configured debris; absent = derived from the kind by the client (see defaultDebris). */
  readonly debris?: DebrisStyle;
}
export type ModificationDefinition = DefinitionBase &
  (
    | { readonly kind: 'fracture'; readonly style: FractureStyle }
    | { readonly kind: 'wear'; readonly style: WearStyle }
    | { readonly kind: 'glow'; readonly style: GlowStyle }
    | { readonly kind: 'growth'; readonly style: GrowthStyle }
  );

export interface ChestModificationProfile {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly parts: readonly ChestPart[];
  readonly colorZones: readonly ColorZone[];
  readonly catalog: readonly ModificationDefinition[];
}

const fail = (message: string): never => {
  throw new DomainError('INVALID_MODIFICATION_PROFILE', message);
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown, what: string) =>
  typeof value === 'string' && /^[\w.-]{1,64}$/.test(value)
    ? value
    : fail(`${what} must be a short identifier.`);
const text = (value: unknown, what: string, max = 128) =>
  typeof value === 'string' && value.trim() && value.length <= max
    ? value
    : fail(`${what} must be a non-empty string.`);
const color = (value: unknown, what: string) =>
  typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : fail(`${what} must be a six-digit hex colour.`);
const number = (value: unknown, what: string, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fail(`${what} must be within ${min}..${max}.`);
const integer = (value: unknown, what: string, min: number, max: number) =>
  Number.isSafeInteger(value) ? number(value, what, min, max) : fail(`${what} must be an integer.`);
function list<T>(
  value: unknown,
  what: string,
  max: number,
  copy: (item: unknown, index: number) => T,
): readonly T[] {
  if (!Array.isArray(value) || value.length > max)
    fail(`${what} must be a list of at most ${max}.`);
  return Object.freeze((value as unknown[]).map(copy));
}
const names = (value: unknown, what: string) =>
  list(value ?? [], what, 32, (item, i) => text(item, `${what}[${i}]`));

const anchorOf = (
  value: unknown,
  fallback: GrowthStyle['anchor'],
  what: string,
): GrowthStyle['anchor'] =>
  value === undefined
    ? fallback
    : ['top', 'bottom', 'edges', 'all'].includes(value as string)
      ? (value as GrowthStyle['anchor'])
      : fail(`${what}.anchor is unknown.`);

function copyStyle(kind: ModificationKind, value: unknown, what: string) {
  if (!isRecord(value)) return fail(`${what} must be an object.`);
  const v = value;
  switch (kind) {
    case 'fracture': {
      const minLength = integer(v.minLength, `${what}.minLength`, 1, 64);
      return {
        branches: integer(v.branches, `${what}.branches`, 1, 1024),
        minLength,
        maxLength: integer(v.maxLength, `${what}.maxLength`, minLength, 96),
        drift: number(v.drift, `${what}.drift`, 0, 1),
        scarColor: color(v.scarColor, `${what}.scarColor`),
        scale: number(v.scale, `${what}.scale`, 0.1, 8),
      };
    }
    case 'wear': {
      const minRadius = number(v.minRadius, `${what}.minRadius`, 0.3, 16);
      return {
        color: color(v.color, `${what}.color`),
        spots: integer(v.spots, `${what}.spots`, 0, 1024),
        minRadius,
        maxRadius: number(v.maxRadius, `${what}.maxRadius`, minRadius, 24),
        scratches: integer(v.scratches, `${what}.scratches`, 0, 512),
        scale: number(v.scale, `${what}.scale`, 0.1, 8),
        ...(v.colorEnd === undefined ? {} : { colorEnd: color(v.colorEnd, `${what}.colorEnd`) }),
        anchor: anchorOf(v.anchor, 'all', what),
        opacity: number(v.opacity ?? 0.8, `${what}.opacity`, 0, 1),
      };
    }
    case 'glow': {
      const pattern = ['runes', 'veins', 'sparks'].includes(v.pattern as string)
        ? (v.pattern as GlowStyle['pattern'])
        : fail(`${what}.pattern is unknown.`);
      return {
        pattern,
        density: number(v.density, `${what}.density`, 0, 1),
        scale: number(v.scale, `${what}.scale`, 0.1, 8),
        ...(v.color === undefined ? {} : { color: color(v.color, `${what}.color`) }),
        pulse: number(v.pulse ?? 0, `${what}.pulse`, 0, 4),
        brightness: number(v.brightness ?? 0.35, `${what}.brightness`, 0, 1),
      };
    }
    case 'growth': {
      const type = GROWTH_TYPES.includes(v.type as GrowthStyle['type'])
        ? (v.type as GrowthStyle['type'])
        : fail(`${what}.type is unknown.`);
      const anchor = anchorOf(v.anchor, 'top', what);
      return {
        type,
        color: color(v.color, `${what}.color`),
        scale: number(v.scale, `${what}.scale`, 0.1, 8),
        spread: number(v.spread ?? 0, `${what}.spread`, 0, 1),
        count: integer(v.count ?? 0, `${what}.count`, 0, 64),
        opacity: number(v.opacity ?? 1, `${what}.opacity`, 0, 1),
        anchor,
        glow: number(v.glow ?? 0, `${what}.glow`, 0, 1),
        ...(v.highlight === undefined
          ? {}
          : { highlight: color(v.highlight, `${what}.highlight`) }),
      };
    }
  }
}

function copyDebris(value: unknown, what: string): DebrisStyle {
  if (!isRecord(value)) return fail(`${what} must be an object.`);
  const shape = DEBRIS_SHAPES.includes(value.shape as DebrisStyle['shape'])
    ? (value.shape as DebrisStyle['shape'])
    : fail(`${what}.shape is unknown.`);
  return Object.freeze({
    shape,
    color: color(value.color, `${what}.color`),
    share: number(value.share ?? 1, `${what}.share`, 0, 4),
  });
}

/** Debris a modification throws off when no explicit style is configured. */
export function defaultDebris(definition: ModificationDefinition, accent: string): DebrisStyle {
  if (definition.debris) return definition.debris;
  switch (definition.kind) {
    case 'fracture':
      return { shape: 'chip', color: definition.style.scarColor, share: 0.6 };
    case 'wear':
      return {
        shape: 'flake',
        color: definition.style.colorEnd ?? definition.style.color,
        share: 1,
      };
    case 'glow':
      return { shape: 'spark', color: definition.style.color ?? accent, share: 0.8 };
    case 'growth': {
      const style = definition.style;
      const shape = (
        {
          moss: 'leaf',
          vines: 'leaf',
          lichen: 'leaf',
          frost: 'shard',
          snow: 'puff',
          crystals: 'shard',
          cobweb: 'flake',
          blight: 'spark',
        } as const
      )[style.type];
      return {
        shape,
        color: style.type === 'blight' ? (style.highlight ?? style.color) : style.color,
        share: 1.2,
      };
    }
  }
}

/** Validates server data. Unknown modification kinds are skipped so newer servers do not break older clients. */
export function copyModificationProfile(value: unknown): ChestModificationProfile {
  if (!isRecord(value) || value.schemaVersion !== 1)
    return fail('Unsupported modification profile version.');
  const parts = list(value.parts, 'parts', 16, (item, i) => {
    if (!isRecord(item)) return fail(`parts[${i}] must be an object.`);
    const nodes = names(item.nodes, `parts[${i}].nodes`);
    if (!nodes.length) fail(`parts[${i}] must name at least one node.`);
    if (item.swing !== undefined && typeof item.swing !== 'boolean')
      fail(`parts[${i}].swing must be a boolean.`);
    return Object.freeze({
      id: id(item.id, `parts[${i}].id`),
      label: text(item.label, `parts[${i}].label`, 48),
      nodes,
      ...(item.swing ? { swing: true } : {}),
    });
  });
  if (new Set(parts.map((part) => part.id)).size !== parts.length) fail('Part ids must be unique.');
  const partIds = new Set(parts.map((part) => part.id));
  const colorZones = list(value.colorZones, 'colorZones', 32, (item, i) => {
    if (!isRecord(item)) return fail(`colorZones[${i}] must be an object.`);
    const role = PALETTE_ROLES.includes(item.role as PaletteRole)
      ? (item.role as PaletteRole)
      : fail(`colorZones[${i}].role is unknown.`);
    const mode: ColorZone['mode'] =
      item.mode === 'replace' || item.mode === 'tint'
        ? item.mode
        : fail(`colorZones[${i}].mode is unknown.`);
    const zone = {
      role,
      mode,
      strength: number(item.strength ?? 1, `colorZones[${i}].strength`, 0, 1),
      materials: names(item.materials, `colorZones[${i}].materials`),
      nodes: names(item.nodes, `colorZones[${i}].nodes`),
    };
    if (!zone.materials.length && !zone.nodes.length)
      fail(`colorZones[${i}] must target materials or nodes.`);
    return Object.freeze(zone);
  });
  const catalog = list(value.catalog, 'catalog', 32, (item) => item)
    .filter((item) => isRecord(item) && MODIFICATION_KINDS.includes(item.kind as ModificationKind))
    .map((item, i) => {
      const v = item as Record<string, unknown>,
        what = `catalog[${i}]`;
      const kind = v.kind as ModificationKind;
      const targets = names(v.parts, `${what}.parts`);
      if (!targets.length || targets.some((part) => !partIds.has(part)))
        fail(`${what}.parts must reference declared parts.`);
      const debris = v.debris === undefined ? undefined : copyDebris(v.debris, `${what}.debris`);
      return Object.freeze({
        id: id(v.id, `${what}.id`),
        label: text(v.label, `${what}.label`, 48),
        kind,
        parts: targets,
        style: Object.freeze(copyStyle(kind, v.style, `${what}.style`)),
        ...(debris ? { debris } : {}),
      }) as ModificationDefinition;
    });
  if (new Set(catalog.map((entry) => entry.id)).size !== catalog.length)
    fail('Modification ids must be unique.');
  return Object.freeze({
    schemaVersion: 1,
    revision: text(value.revision, 'revision', 64),
    parts,
    colorZones,
    catalog: Object.freeze(catalog),
  });
}
