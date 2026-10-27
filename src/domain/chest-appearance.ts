import { DomainError } from './error.ts';
import {
  PALETTE_ROLES,
  type ChestModificationProfile,
  type ModificationDefinition,
  type PaletteRole,
} from './chest-modifications.ts';

/** One catalogue entry of the instance's model, as assigned by the server. */
export interface AppliedModification {
  readonly id: string;
  readonly intensity: number;
  readonly seed: number;
}

/** Individual visual state; model/ownership/lifecycle are separate concerns. */
export interface ChestAppearance {
  readonly schemaVersion: 2;
  readonly revision: number;
  readonly seed: number;
  readonly palette: Readonly<Record<PaletteRole, string>>;
  readonly modifications: readonly AppliedModification[];
}
export type AppearanceChange = {
  readonly palette?: Partial<ChestAppearance['palette']>;
  /** Upsert by id; intensity 0 removes the entry. */
  readonly modifications?: readonly (Omit<AppliedModification, 'seed'> & {
    readonly seed?: number;
  })[];
};

/** v1 stored body/lid damage directly; profiles that keep these ids receive old saves unchanged. */
export const LEGACY_DAMAGE_MODIFICATIONS = Object.freeze({
  body: 'body-cracks',
  lid: 'lid-cracks',
});

const invalid = (message: string): never => {
  throw new DomainError('INVALID_APPEARANCE', message);
};
const isSeed = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff;

function copyModification(value: unknown): AppliedModification {
  const v = value as AppliedModification;
  if (
    !v ||
    typeof v !== 'object' ||
    typeof v.id !== 'string' ||
    !/^[\w.-]{1,64}$/.test(v.id) ||
    !Number.isFinite(v.intensity) ||
    v.intensity <= 0 ||
    v.intensity > 1 ||
    !isSeed(v.seed)
  ) {
    invalid('Modifications need an id, an intensity within (0, 1] and a seed.');
  }
  return Object.freeze({ id: v.id, intensity: v.intensity, seed: v.seed });
}

function legacyModifications(v: {
  seed: number;
  damage?: { body?: unknown; lid?: unknown };
}): AppliedModification[] {
  if (!v.damage || typeof v.damage !== 'object') invalid('Invalid appearance version or seed.');
  const result: AppliedModification[] = [];
  for (const [part, id] of Object.entries(LEGACY_DAMAGE_MODIFICATIONS) as [
    keyof typeof LEGACY_DAMAGE_MODIFICATIONS,
    string,
  ][]) {
    const value = v.damage![part];
    if (!Number.isFinite(value) || (value as number) < 0 || (value as number) > 1)
      invalid('Damage must be between zero and one.');
    if ((value as number) > 0) result.push({ id, intensity: value as number, seed: v.seed });
  }
  return result;
}

export function copyChestAppearance(value: unknown): ChestAppearance {
  if (!value || typeof value !== 'object') invalid('An appearance must be an object.');
  const v = value as Record<string, any>;
  if (
    (v.schemaVersion !== 1 && v.schemaVersion !== 2) ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    !isSeed(v.seed) ||
    !v.palette
  )
    invalid('Invalid appearance version or seed.');
  for (const key of PALETTE_ROLES) {
    if (typeof v.palette[key] !== 'string' || !/^#[\da-f]{6}$/i.test(v.palette[key])) {
      invalid('Appearance colors must be six-digit hex values.');
    }
  }
  const source = v.schemaVersion === 1 ? legacyModifications(v as never) : v.modifications;
  if (!Array.isArray(source) || source.length > 32)
    invalid('Modifications must be a list of at most 32.');
  const modifications = (source as unknown[]).map(copyModification);
  if (new Set(modifications.map((item) => item.id)).size !== modifications.length)
    invalid('Modification ids must be unique.');
  return Object.freeze({
    schemaVersion: 2,
    revision: v.revision,
    seed: v.seed,
    palette: Object.freeze(
      Object.fromEntries(PALETTE_ROLES.map((key) => [key, v.palette[key].toLowerCase()])) as Record<
        PaletteRole,
        string
      >,
    ),
    modifications: Object.freeze(modifications),
  });
}

export function createChestAppearance(seed = 731): ChestAppearance {
  return copyChestAppearance({
    schemaVersion: 2,
    revision: 0,
    seed,
    palette: { shell: '#343342', panel: '#3c5050', metal: '#6f767c', accent: '#35905f' },
    modifications: [],
  });
}

export function changeChestAppearance(
  current: ChestAppearance,
  change: AppearanceChange,
): ChestAppearance {
  const modifications = new Map(current.modifications.map((item) => [item.id, item]));
  for (const item of change.modifications ?? []) {
    if (item.intensity === 0) {
      modifications.delete(item.id);
      continue;
    }
    const previous = modifications.get(item.id);
    modifications.set(item.id, {
      id: item.id,
      intensity: item.intensity,
      seed: item.seed ?? previous?.seed ?? modificationSeed(current.seed, item.id),
    });
  }
  return copyChestAppearance({
    ...current,
    revision: current.revision + 1,
    palette: { ...current.palette, ...change.palette },
    modifications: [...modifications.values()],
  });
}

/** Include model and profile revisions so geometry/UV/profile changes also invalidate previews. */
export function chestAppearanceKey(modelRevision: string, appearance: ChestAppearance): string {
  const v = copyChestAppearance(appearance);
  return JSON.stringify([
    modelRevision,
    v.schemaVersion,
    v.revision,
    v.seed,
    PALETTE_ROLES.map((key) => v.palette[key]),
    v.modifications.map((item) => [item.id, item.intensity, item.seed]),
  ]);
}

export interface ResolvedModification {
  readonly definition: ModificationDefinition;
  readonly intensity: number;
  readonly seed: number;
}

/** Pairs instance entries with the model catalogue; entries unknown to this model are not drawn. */
export function resolveModifications(
  appearance: ChestAppearance,
  profile: ChestModificationProfile,
): readonly ResolvedModification[] {
  const catalog = new Map(profile.catalog.map((definition) => [definition.id, definition]));
  return appearance.modifications.flatMap((item) => {
    const definition = catalog.get(item.id);
    return definition ? [{ definition, intensity: item.intensity, seed: item.seed }] : [];
  });
}

/** Physical condition per part: the strongest fracture or wear covering it. */
export function partConditions(appearance: ChestAppearance, profile: ChestModificationProfile) {
  const resolved = resolveModifications(appearance, profile);
  return profile.parts.map((part) => ({
    part,
    value: Math.max(
      0,
      ...resolved
        .filter(
          (item) =>
            (item.definition.kind === 'fracture' || item.definition.kind === 'wear') &&
            item.definition.parts.includes(part.id),
        )
        .map((item) => item.intensity),
    ),
  }));
}

/**
 * Persists what an actual break did: each broken part's fracture entries rise to its severity
 * (never lowering existing damage). A chest that survived intact gains nothing.
 */
export function withBreakageDamage(
  appearance: ChestAppearance,
  profile: ChestModificationProfile,
  parts: readonly { readonly part: string; readonly severity: number }[],
): ChestAppearance {
  const current = new Map(appearance.modifications.map((item) => [item.id, item.intensity]));
  const raised = new Map<string, number>();
  for (const { part, severity } of parts) {
    for (const definition of profile.catalog) {
      if (definition.kind !== 'fracture' || !definition.parts.includes(part)) continue;
      const level = Math.max(severity, raised.get(definition.id) ?? 0);
      if (level > (current.get(definition.id) ?? 0)) raised.set(definition.id, Math.min(1, level));
    }
  }
  return raised.size
    ? changeChestAppearance(appearance, {
        modifications: [...raised].map(([id, intensity]) => ({ id, intensity })),
      })
    : appearance;
}

/** Stable default seed of a catalogue entry on an instance, so a pattern keeps its shape everywhere. */
export function modificationSeed(appearanceSeed: number, id: string): number {
  return (appearanceSeed ^ hash(id)) >>> 0;
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++)
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
}
