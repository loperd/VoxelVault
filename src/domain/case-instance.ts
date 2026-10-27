import { copyChestAppearance, type ChestAppearance } from './chest-appearance.ts';
import { copyItem, type Item } from './item.ts';
import { DomainError } from './error.ts';
import { BREAK_MOMENTS, type BreakMoment } from './chest-breakage.ts';

export const ITEM_STATES = ['intact', 'slight', 'heavy', 'broken'] as const;
export type ItemState = (typeof ITEM_STATES)[number];

/** One item of a chest's contents and its weight in the roll. */
export interface ContentSlot {
  readonly item: Item;
  readonly weight: number;
}
/** A trait of the chest (cracks, moss, runes): intensity 0..1, seed for how it is drawn. */
export interface ChestTrait {
  readonly id: string;
  readonly intensity: number;
  readonly seed: number;
}

/**
 * A chest as the server has it. Its contents, traits, rarity and condition are frozen by the
 * server; the client only reads them. destroyed: the chest broke on landing or while opening and
 * gives no reward.
 */
export interface CaseInstance {
  readonly id: string;
  readonly caseId: string;
  readonly appearance: ChestAppearance;
  readonly status: 'available' | 'opening' | 'opened' | 'destroyed';
  readonly sessionId?: string;
  readonly contents: readonly ContentSlot[];
  readonly traits: readonly ChestTrait[];
  readonly rarity?: string;
  readonly condition: number;
  /** The item the opening dropped and the state it fell in. */
  readonly reward?: Item;
  readonly rewardState?: ItemState;
  readonly openedAt?: string;
  readonly destroyedAt?: BreakMoment;
}

const fail = (): never => {
  throw new DomainError('INVALID_CASE_INSTANCE', 'Invalid case ownership state.');
};

export function copyCaseInstance(value: unknown): CaseInstance {
  if (!value || typeof value !== 'object')
    throw new DomainError('INVALID_CASE_INSTANCE', 'Invalid case instance.');
  const v = value as CaseInstance;
  if (
    ![v.id, v.caseId].every((id) => typeof id === 'string' && id.trim() && id.length <= 128) ||
    !['available', 'opening', 'opened', 'destroyed'].includes(v.status) ||
    (v.status !== 'available' &&
      (typeof v.sessionId !== 'string' || !v.sessionId.trim() || v.sessionId.length > 256)) ||
    (v.status === 'opened' && !v.reward) ||
    (v.openedAt !== undefined &&
      (v.status !== 'opened' ||
        typeof v.openedAt !== 'string' ||
        !Number.isFinite(Date.parse(v.openedAt)))) ||
    (v.status === 'available' && (v.sessionId !== undefined || v.reward !== undefined)) ||
    (v.status !== 'opened' && (v.reward !== undefined || v.rewardState !== undefined)) ||
    (v.rewardState !== undefined && !ITEM_STATES.includes(v.rewardState)) ||
    (v.destroyedAt !== undefined &&
      (v.status !== 'destroyed' || !BREAK_MOMENTS.includes(v.destroyedAt))) ||
    (v.rarity !== undefined && typeof v.rarity !== 'string') ||
    typeof v.condition !== 'number' ||
    !(v.condition >= 0 && v.condition <= 1) ||
    !Array.isArray(v.contents) ||
    !Array.isArray(v.traits)
  )
    fail();
  const contents = v.contents.map((slot) => {
    if (
      !slot ||
      typeof slot.weight !== 'number' ||
      !Number.isFinite(slot.weight) ||
      slot.weight < 0
    )
      fail();
    return Object.freeze({ item: copyItem(slot.item), weight: slot.weight });
  });
  const traits = v.traits.map((trait) => {
    if (
      !trait ||
      typeof trait.id !== 'string' ||
      !trait.id ||
      typeof trait.intensity !== 'number' ||
      !(trait.intensity >= 0 && trait.intensity <= 1) ||
      !Number.isSafeInteger(trait.seed) ||
      trait.seed < 0
    )
      fail();
    return Object.freeze({ id: trait.id, intensity: trait.intensity, seed: trait.seed });
  });
  return Object.freeze({
    id: v.id,
    caseId: v.caseId,
    appearance: copyChestAppearance(v.appearance),
    status: v.status,
    contents: Object.freeze(contents),
    traits: Object.freeze(traits),
    condition: v.condition,
    ...(v.rarity ? { rarity: v.rarity } : {}),
    ...(v.status !== 'available' ? { sessionId: v.sessionId } : {}),
    ...(v.reward ? { reward: copyItem(v.reward), rewardState: v.rewardState ?? 'intact' } : {}),
    ...(v.openedAt ? { openedAt: v.openedAt } : {}),
    ...(v.destroyedAt ? { destroyedAt: v.destroyedAt } : {}),
  });
}

/** Shown at once while the server lands and opens the chest; the server's answer replaces it. */
export function claimCase(instance: CaseInstance, sessionId: string): CaseInstance {
  if (instance.sessionId === sessionId && instance.status !== 'available') return instance;
  if (instance.status !== 'available')
    throw new DomainError('CASE_UNAVAILABLE', 'This case has already been opened or reserved.');
  return copyCaseInstance({ ...instance, status: 'opening', sessionId });
}

/** Consumed one way or another: opened with a reward or destroyed. */
export function isConsumed(instance: CaseInstance): boolean {
  return instance.status === 'opened' || instance.status === 'destroyed';
}

/** Prefer a fresh owned case; otherwise resume an unfinished opening of this type. */
export function nextOwnedCase(
  instances: readonly CaseInstance[],
  caseId: string,
): CaseInstance | undefined {
  return (
    instances.find((item) => item.caseId === caseId && item.status === 'available') ??
    instances.find((item) => item.caseId === caseId && item.status === 'opening')
  );
}
