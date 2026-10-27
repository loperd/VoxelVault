import type { BreakMoment } from '../../domain/chest-breakage.ts';
import type { ItemState } from '../../domain/case-instance.ts';
import type { Item } from '../../domain/item.ts';

/** What an opening ends in, as the server decided it: a prize (and the state it fell in), or the chest broke (and when). */
export type ChestOutcome =
  { readonly prize: Item; readonly condition?: ItemState } | { readonly destroyed: BreakMoment };

export interface OutcomeGateway {
  /** The same session always gets the same outcome, so a retry after a lost response is safe. */
  decide(sessionId: string, signal: AbortSignal): Promise<ChestOutcome>;
}
