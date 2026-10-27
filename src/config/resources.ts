import type { ItemState } from '../domain/case-instance.ts';

/**
 * How the wallet's resources read on screen. The server names them (economy.json: the shared
 * currency and each collection's material); an id missing here is shown as it is.
 */
export const RESOURCES: Readonly<
  Record<string, { readonly title: string; readonly glyph: string }>
> = Object.freeze({
  currency: { title: 'Монеты', glyph: '◎' },
  'travel-scraps': { title: 'Дорожный лом', glyph: '⚙' },
  'deep-ore': { title: 'Глубинная руда', glyph: '◆' },
  'end-shards': { title: 'Осколки Края', glyph: '✦' },
  'dragon-scales': { title: 'Драконья чешуя', glyph: '⬢' },
});

export function resourceTitle(id: string): string {
  return RESOURCES[id]?.title ?? id;
}
export function resourceGlyph(id: string): string {
  return RESOURCES[id]?.glyph ?? '•';
}

export const ITEM_STATE_LABELS: Readonly<Record<ItemState, string>> = Object.freeze({
  intact: 'Целый',
  slight: 'Потёртый',
  heavy: 'Повреждён',
  broken: 'Сломан',
});
