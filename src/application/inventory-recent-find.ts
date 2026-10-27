import type { PlayerInventory } from './ports/player-inventory.ts';
import type { RecentFind, RecentFindState } from './ports/recent-find.ts';

/**
 * The last find of a chest type is the reward of the player's most recently opened chest of that
 * type, as the server has it: nothing is remembered in the browser.
 */
export class InventoryRecentFind implements RecentFind {
  private state: RecentFindState = Object.freeze({ item: null });
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private readonly inventory: PlayerInventory;
  private readonly caseId: string;

  constructor(inventory: PlayerInventory, caseId: string) {
    this.inventory = inventory;
    this.caseId = caseId;
    this.state = this.find();
    this.unsubscribe = inventory.subscribe(() => {
      const next = this.find();
      if (next.item?.id === this.state.item?.id && next.item?.title === this.state.item?.title)
        return;
      this.state = next;
      for (const listener of [...this.listeners]) listener();
    });
  }

  readonly getState = (): RecentFindState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  private find(): RecentFindState {
    let latest:
      { at: number; index: number; item: NonNullable<RecentFindState['item']> } | undefined;
    this.inventory.getState().forEach((chest, index) => {
      if (chest.caseId !== this.caseId || chest.status !== 'opened' || !chest.reward) return;
      const at = chest.openedAt ? Date.parse(chest.openedAt) : 0;
      if (!latest || at > latest.at || (at === latest.at && index > latest.index))
        latest = { at, index, item: chest.reward };
    });
    return Object.freeze({ item: latest?.item ?? null });
  }
}
