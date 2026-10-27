import type { Amount, OwnedItem } from '../../domain/owned-item.ts';

export type WorkshopAction = 'repair' | 'salvage' | 'sell';

export interface ItemsState {
  /** Has the list been read from the server at least once? */
  readonly loaded: boolean;
  readonly items: readonly OwnedItem[];
}

/** The result of a merge: the item that stayed and whether the merge mended it. */
export interface MergeResult {
  readonly kept: OwnedItem;
  readonly mended: boolean;
}

/**
 * The player's items, as the server has them. Every action is the server's: it
 * prices, charges and changes; the list is read again after each one.
 */
export interface PlayerItems {
  getState(): ItemsState;
  subscribe(listener: () => void): () => void;
  load(signal?: AbortSignal): Promise<void>;
  /** Repair, salvage or sell an item; answers what was paid (repair) or gained. */
  work(itemId: string, action: WorkshopAction): Promise<Amount>;
  /** Merge two damaged twins; the better one stays. */
  merge(a: string, b: string): Promise<MergeResult>;
}
