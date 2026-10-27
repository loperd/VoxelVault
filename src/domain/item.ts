export type ItemId = string;
/** The rulebook's item rarities, lowest first. */
export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export type Rarity = (typeof RARITIES)[number];

export interface Item {
  readonly id: ItemId;
  readonly title: string;
  readonly image: string;
  readonly rarity: Rarity;
  readonly displayWeight: number;
}
import { DomainError } from './error.ts';

export function assertItem(value: unknown): asserts value is Item {
  if (!value || typeof value !== 'object') {
    throw new DomainError('INVALID_ITEM', 'An item must be an object.');
  }

  const item = value as Record<string, unknown>;
  for (const field of ['id', 'title', 'image'] as const) {
    if (typeof item[field] !== 'string' || item[field].trim().length === 0) {
      throw new DomainError('INVALID_ITEM', `Item ${field} must be a nonempty string.`);
    }
  }

  if (typeof item.rarity !== 'string' || !(RARITIES as readonly string[]).includes(item.rarity)) {
    throw new DomainError('INVALID_ITEM', 'Item rarity is not supported.');
  }
  if (
    typeof item.displayWeight !== 'number' ||
    !Number.isFinite(item.displayWeight) ||
    item.displayWeight < 0
  ) {
    throw new DomainError('INVALID_ITEM', 'Display weight must be finite and nonnegative.');
  }
}

export function copyItem(item: Item): Item {
  assertItem(item);
  return Object.freeze({
    id: item.id,
    title: item.title,
    image: item.image,
    rarity: item.rarity,
    displayWeight: item.displayWeight,
  });
}

export function copyCatalog(items: readonly Item[]): readonly Item[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new DomainError('EMPTY_CATALOG', 'The catalog must contain at least one item.');
  }

  const catalog = Array.from(items, copyItem);
  if (new Set(catalog.map((item) => item.id)).size !== catalog.length) {
    throw new DomainError('DUPLICATE_ITEM', 'Catalog item ids must be unique.');
  }
  return Object.freeze(catalog);
}
