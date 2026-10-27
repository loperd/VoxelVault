import { DomainError } from './error.ts';
import { ITEM_STATES, type ItemState } from './case-instance.ts';
import { copyItem, type Item } from './item.ts';

/** A whole number of one resource: the shared currency or a collection's material. */
export interface Amount {
  readonly resource: string;
  readonly value: number;
}

/** What each workshop action would cost or bring now, as the server priced it. */
export interface ItemOffers {
  /** Absent for an intact item. */
  readonly repair?: Amount;
  readonly salvage: Amount;
  readonly sell: Amount;
  /** The twin the server merges it with; absent when there is nothing to merge with. */
  readonly mergeWith?: string;
  /** Percent chance that this merge mends the item that stays. */
  readonly mergeRepair: number;
}

/** One item the player owns, in the state it is in. Origin is the chest it dropped from. */
export interface OwnedItem {
  readonly id: string;
  readonly item: Item;
  readonly state: ItemState;
  readonly origin: string;
  readonly status?: 'available' | 'locked';
  readonly operationId?: string;
  /** Absent for an item the rulebook no longer knows: it cannot be worked. */
  readonly offers?: ItemOffers;
}

export type Balances = Readonly<Record<string, number>>;

export const CURRENCY = 'currency';

export function isDamaged(item: OwnedItem): boolean {
  return item.state !== 'intact';
}

export function canAfford(balances: Balances, amount: Amount): boolean {
  return (balances[amount.resource] ?? 0) >= amount.value;
}

function copyAmount(value: unknown): Amount {
  const v = value as Record<string, unknown> | null;
  if (
    !v ||
    typeof v.resource !== 'string' ||
    !v.resource ||
    typeof v.value !== 'number' ||
    !Number.isSafeInteger(v.value) ||
    v.value < 0
  ) {
    throw new DomainError(
      'INVALID_ITEM',
      'An amount needs a resource and a whole nonnegative value.',
    );
  }
  return Object.freeze({ resource: v.resource, value: v.value });
}

export function copyOwnedItem(value: OwnedItem): OwnedItem {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.origin !== 'string' ||
    !(ITEM_STATES as readonly string[]).includes(value.state)
  ) {
    throw new DomainError(
      'INVALID_ITEM',
      'An owned item needs an id, an origin and a known state.',
    );
  }
  const offers = value.offers;
  if (
    offers !== undefined &&
    (typeof offers.mergeRepair !== 'number' ||
      !(offers.mergeRepair >= 0 && offers.mergeRepair <= 100))
  ) {
    throw new DomainError('INVALID_ITEM', 'A merge chance is a percent.');
  }
  if (
    offers?.mergeWith !== undefined &&
    (typeof offers.mergeWith !== 'string' || !offers.mergeWith || offers.mergeWith === value.id)
  ) {
    throw new DomainError('INVALID_ITEM', 'A merge twin is another item.');
  }
  return Object.freeze({
    id: value.id,
    item: copyItem(value.item),
    state: value.state,
    origin: value.origin,
    ...(value.status === 'locked' || value.status === 'available' ? { status: value.status } : {}),
    ...(typeof value.operationId === 'string' ? { operationId: value.operationId } : {}),
    ...(offers
      ? {
          offers: Object.freeze({
            ...(offers.repair ? { repair: copyAmount(offers.repair) } : {}),
            salvage: copyAmount(offers.salvage),
            sell: copyAmount(offers.sell),
            mergeRepair: offers.mergeRepair,
            ...(offers.mergeWith ? { mergeWith: offers.mergeWith } : {}),
          }),
        }
      : {}),
  });
}

export function copyBalances(value: unknown): Balances {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DomainError('INVALID_ITEM', 'Balances must be an object.');
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [, amount] of entries) {
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0)
      throw new DomainError('INVALID_ITEM', 'A balance is a whole nonnegative number.');
  }
  return Object.freeze(Object.fromEntries(entries)) as Balances;
}
