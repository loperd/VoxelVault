import type { CaseInstance } from '../../../domain/case-instance.ts';
import {
  copyChestBreakage,
  type BreakMoment,
  type BreakPattern,
  type ChestBreakage,
} from '../../../domain/chest-breakage.ts';
import { partConditions } from '../../../domain/chest-appearance.ts';
import type { ChestModificationProfile } from '../../../domain/chest-modifications.ts';

/**
 * How a chest the server destroyed comes apart. The server decides that it breaks and when
 * (impact or opening); how the wreck looks is drawn here, seeded by the chest, so the same chest
 * always breaks the same way:
 *   - the carrier (the first profile part, the body) always comes apart: that is the destruction;
 *   - the worse another part's condition, the likelier it chips or comes off; a decrepit chest
 *     (very poor condition) comes apart entirely;
 *   - other parts (lid, latch) may simply fall off;
 *   - impact breaks are mechanical (crumble, split), opening breaks are energy bursts (shatter, split).
 */
export function destroyedBreakage(
  instance: CaseInstance,
  profile: ChestModificationProfile,
  moment: BreakMoment,
): ChestBreakage {
  const next = seeded(hash(`${instance.id}:${moment}`));
  const conditions = partConditions(instance.appearance, profile);
  const worst = Math.max(0, ...conditions.map((item) => item.value));
  const decrepit = worst >= 0.85;
  const pick = (options: readonly BreakPattern[]) => options[Math.floor(next() * options.length)]!;
  const parts = conditions.flatMap(({ part, value }, index) => {
    const carrier = index === 0;
    if (!carrier && !decrepit && (value === 0 || next() > value + 0.15)) return [];
    const detached = carrier || decrepit || next() < Math.max(0, (value - 0.45) / 0.55) * 0.8;
    const pattern = !detached
      ? 'shatter'
      : !carrier && next() < 0.55
        ? 'fall'
        : moment === 'impact'
          ? pick(['crumble', 'split', 'split'])
          : pick(['shatter', 'shatter', 'split']);
    const severity = Math.max(
      carrier || decrepit ? 0.5 : 0,
      Math.min(1, value * (0.6 + next() * 0.4)),
    );
    return [{ part: part.id, severity: Math.round(severity * 100) / 100, detached, pattern }];
  });
  return copyChestBreakage(
    { seed: Math.floor(next() * 0xffffffff), moment, parts, destroyed: true },
    profile,
  );
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++)
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
}
function seeded(seed: number) {
  let state = seed || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
