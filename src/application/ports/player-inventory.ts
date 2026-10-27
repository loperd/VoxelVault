import type { CaseInstance } from '../../domain/case-instance.ts';
import type { ChestOutcome } from './outcome-gateway.ts';

export interface PlayerInventory {
  getState(): readonly CaseInstance[];
  subscribe(listener: () => void): () => void;
  /** Claim the chest for the session and open it: the server lands it and decides the outcome. */
  open(instanceId: string, sessionId: string, signal?: AbortSignal): Promise<ChestOutcome>;
  /** Show the chest as the server left it, once the outcome has been shown to the player. */
  reveal(instanceId: string): void;
  /** What merging two available chests of one type would likely make, by the server's chances. */
  mergeOdds(a: string, b: string, signal?: AbortSignal): Promise<MergeOdds>;
  /** Spend two available chests of one type into a new one; the list is the server's afterwards. */
  merge(a: string, b: string): Promise<CaseInstance>;
}

/**
 * The server's chances, in percent, for a merge: each trait of either chest may stay and, held by
 * both, rise a tier (damage never stays); of the items the two hold together the new chest keeps
 * `kept`, each with the chance `keep`.
 */
export interface MergeOdds {
  readonly traits: readonly {
    readonly id: string;
    readonly keep: number;
    readonly upgrade: number;
  }[];
  readonly contents: { readonly total: number; readonly kept: number; readonly keep: number };
}

/** The opening session tells the owner when the outcome is on screen. */
export interface CaseOwnership {
  reveal(sessionId: string): void;
}
