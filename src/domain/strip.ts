import { DomainError } from './error.ts';
import { copyCatalog, copyItem, type Item } from './item.ts';
import { randomIndex, type RandomSource } from './random-source.ts';

export interface StripSlot {
  readonly id: string;
  readonly item: Item;
}

export interface TargetSelection {
  readonly slots: readonly StripSlot[];
  readonly targetIndex: number;
  readonly prize: Item;
}

export function buildStrip(
  items: readonly Item[],
  capacity: number,
  random: RandomSource,
): readonly StripSlot[] {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new DomainError('INVALID_CAPACITY', 'Strip capacity must be a positive integer.');
  }

  const catalog = [...copyCatalog(items)];
  for (let i = catalog.length - 1; i > 0; i -= 1) {
    const j = randomIndex(random, i + 1);
    [catalog[i], catalog[j]] = [catalog[j]!, catalog[i]!];
  }

  const slots: StripSlot[] = [];
  for (const item of catalog) {
    const copies = Math.min(
      capacity - slots.length,
      Math.round((capacity / 100) * item.displayWeight),
    );
    for (let i = 0; i < copies; i += 1) {
      slots.push(Object.freeze({ id: `slot-${slots.length}`, item }));
    }
  }
  return Object.freeze(slots);
}

export function ensureTarget(
  strip: readonly StripSlot[],
  selectedPrize: Item,
  random: RandomSource,
): TargetSelection {
  const prize = copyItem(selectedPrize);
  const slots = copyStrip(strip);
  const matches: number[] = [];
  slots.forEach((slot, index) => {
    if (slot.item.id === prize.id) matches.push(index);
  });

  let targetIndex: number;
  if (matches.length > 0) {
    targetIndex =
      matches.length === 1 ? matches[0]! : matches[randomIndex(random, matches.length)]!;
    // The selected slot uses the authoritative result's title, image and rarity too.
    slots[targetIndex] = Object.freeze({ id: slots[targetIndex]!.id, item: prize });
  } else {
    targetIndex = randomIndex(random, slots.length + 1);
    const ids = new Set(slots.map((slot) => slot.id));
    let number = slots.length;
    while (ids.has(`slot-${number}`)) number += 1;
    slots.splice(targetIndex, 0, Object.freeze({ id: `slot-${number}`, item: prize }));
  }

  return Object.freeze({ slots: Object.freeze(slots), targetIndex, prize });
}

export function assertTarget(selection: TargetSelection): void {
  copyStrip(selection.slots);
  copyItem(selection.prize);
  if (
    !Number.isSafeInteger(selection.targetIndex) ||
    selection.targetIndex < 0 ||
    selection.targetIndex >= selection.slots.length ||
    selection.slots[selection.targetIndex]!.item.id !== selection.prize.id
  ) {
    throw new DomainError('INVALID_TARGET', 'The target slot must contain the selected prize.');
  }
}

function copyStrip(strip: readonly StripSlot[]): StripSlot[] {
  if (!Array.isArray(strip)) {
    throw new DomainError('INVALID_STRIP', 'The strip must be an array.');
  }
  const ids = new Set<string>();
  return Array.from(strip, (slot) => {
    if (!slot || typeof slot.id !== 'string' || slot.id.trim().length === 0 || ids.has(slot.id)) {
      throw new DomainError('INVALID_STRIP', 'Strip slot ids must be nonempty and unique.');
    }
    ids.add(slot.id);
    return Object.freeze({ id: slot.id, item: copyItem(slot.item) });
  });
}
