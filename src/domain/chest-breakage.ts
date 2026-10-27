import { DomainError } from './error.ts';
import type { ChestModificationProfile } from './chest-modifications.ts';

/**
 * How the chest breaks: on the impact after its fall, or while it is being opened. Two different
 * stories: the impact is mechanical (it cracks and collapses where it hit); the opening is an
 * energy overload (the chest cannot hold the power inside, swells and bursts).
 *
 * The server rolls it per session from the case and its characteristics; the client validates and
 * draws it. Each part has its own fate: the body may be destroyed, the lid may fall off, the latch
 * may break. A decrepit chest has every part detached. The fracture geometry itself is computed
 * from `seed`, so every break looks different while a session always replays the same one.
 *   severity  0..1 — chips and how many fragments;
 *   detached       — the part comes apart instead of staying on the chest;
 *   pattern        — shatter (many fragments flung away), split (a few large fragments),
 *                    crumble (fragments pour down from the top), fall (comes off in one piece).
 */
export const BREAK_PATTERNS = ['shatter', 'split', 'crumble', 'fall'] as const;
export type BreakPattern = (typeof BREAK_PATTERNS)[number];
export interface BrokenPart {
  readonly part: string;
  readonly severity: number;
  readonly detached: boolean;
  readonly pattern: BreakPattern;
}
export const BREAK_MOMENTS = ['impact', 'opening'] as const;
export type BreakMoment = (typeof BREAK_MOMENTS)[number];
export interface ChestBreakage {
  readonly seed: number;
  readonly moment: BreakMoment;
  readonly parts: readonly BrokenPart[];
  /** The chest did not survive: no roulette, no reward, just the message. A lost lid alone is not destruction. */
  readonly destroyed: boolean;
}

export const NO_BREAKAGE: ChestBreakage = Object.freeze({
  seed: 0,
  moment: 'opening',
  parts: Object.freeze([]),
  destroyed: false,
});

const fail = (message: string): never => {
  throw new DomainError('INVALID_BREAKAGE', message);
};

export function copyChestBreakage(
  value: unknown,
  profile: ChestModificationProfile,
): ChestBreakage {
  if (!value || typeof value !== 'object') return fail('Breakage must be an object.');
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.seed) || (v.seed as number) < 0 || (v.seed as number) > 0xffffffff)
    fail('Breakage needs a 32-bit seed.');
  if (!BREAK_MOMENTS.includes(v.moment as BreakMoment))
    fail('Breakage moment must be impact or opening.');
  if (!Array.isArray(v.parts) || v.parts.length > profile.parts.length)
    fail('Breakage parts must be a short list.');
  const known = new Set(profile.parts.map((part) => part.id));
  const parts = (v.parts as unknown[]).map((item) => {
    const p = item as Record<string, unknown>;
    if (!p || typeof p !== 'object' || !known.has(p.part as string))
      fail('Breakage must reference parts of the model.');
    if (
      typeof p.severity !== 'number' ||
      !Number.isFinite(p.severity) ||
      p.severity < 0 ||
      p.severity > 1
    )
      fail('Breakage severity must be within 0..1.');
    if (typeof p.detached !== 'boolean') fail('Breakage needs a detached flag.');
    const pattern =
      p.pattern === undefined
        ? 'shatter'
        : BREAK_PATTERNS.includes(p.pattern as BreakPattern)
          ? (p.pattern as BreakPattern)
          : fail('Breakage pattern is unknown.');
    return Object.freeze({
      part: p.part as string,
      severity: p.severity as number,
      detached: p.detached as boolean,
      pattern,
    });
  });
  if (new Set(parts.map((item) => item.part)).size !== parts.length)
    fail('Each part may break only once.');
  if (v.destroyed !== undefined && typeof v.destroyed !== 'boolean')
    fail('Breakage destroyed must be a boolean.');
  const destroyed = v.destroyed === true;
  if (destroyed && !parts.some((item) => item.detached))
    fail('A destroyed chest must lose at least one part.');
  return Object.freeze({
    seed: v.seed as number,
    moment: v.moment as BreakMoment,
    parts: Object.freeze(parts),
    destroyed,
  });
}
