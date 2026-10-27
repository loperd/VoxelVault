import type { ChestOutcome } from './outcome-gateway.ts';
import type { ItemState } from '../../domain/case-instance.ts';
import type { SpinPlan } from '../../domain/spin-plan.ts';
import type { TargetSelection } from '../../domain/strip.ts';

export type SessionCheckpoint =
  | { readonly stage: 'chest'; readonly sessionId: string; readonly outcome?: ChestOutcome }
  | { readonly stage: 'destroyed'; readonly sessionId: string }
  | {
      readonly stage: 'roulette' | 'prize';
      readonly sessionId: string;
      readonly selection: TargetSelection;
      readonly plan: SpinPlan;
      readonly condition?: ItemState;
    };

/** Recovery storage is optional. No browser API belongs in the session controller. */
export interface SessionJournal {
  load(): SessionCheckpoint | undefined;
  save(checkpoint: SessionCheckpoint): void;
  clear(): void;
}
