import type { CaseDefinition } from './cases.ts';
import {
  changeChestAppearance,
  copyChestAppearance,
  type ChestAppearance,
} from '../domain/chest-appearance.ts';
import type { ChestTrait } from '../domain/case-instance.ts';

/**
 * The look of a chest is its traits as the server froze them: each trait the chest's model knows
 * (cracks, rust, moss, snow, runes) is drawn with the server's intensity and seed. A landing that
 * damaged the chest shows as soon as the server says so.
 */
export function chestLook(
  definition: CaseDefinition,
  seed: number,
  traits: readonly ChestTrait[],
): ChestAppearance {
  const base = copyChestAppearance({ ...definition.appearance, seed: seed >>> 0 });
  const known = new Set(definition.model.modifications.catalog.map((entry) => entry.id));
  const modifications = traits
    .filter((trait) => known.has(trait.id) && trait.intensity > 0)
    .map((trait) => ({ id: trait.id, intensity: trait.intensity, seed: trait.seed >>> 0 }));
  return modifications.length ? changeChestAppearance(base, { modifications }) : base;
}
