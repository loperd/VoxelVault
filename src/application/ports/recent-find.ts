import type { Item } from '../../domain/item.ts';

export interface RecentFindState {
  readonly item: Item | null;
}
export interface RecentFind {
  getState(): RecentFindState;
  subscribe(listener: () => void): () => void;
}
