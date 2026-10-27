import type { ItemState } from '../domain/case-instance.ts';
import type { Item } from '../domain/item.ts';
import type { SpinPlan } from '../domain/spin-plan.ts';
import type { StripSlot, TargetSelection } from '../domain/strip.ts';

export type RecoveryAction = 'initialize' | 'open' | 'reset';

interface SessionData {
  readonly catalog: readonly Item[];
  readonly slots: readonly StripSlot[];
}

export interface SessionFailure {
  readonly code: string;
  readonly message: string;
  readonly phase: SessionState['phase'];
  readonly recovery: RecoveryAction;
}

export type SessionDetails =
  | { readonly phase: 'idle' | 'loading' | 'ready' | 'resetting' | 'disposed' }
  | { readonly phase: 'clearing' | 'dropping' | 'opening'; readonly sessionId: string }
  /** The chest broke apart under the energy: the session ends without a reward. */
  | { readonly phase: 'destroyed'; readonly sessionId: string }
  | {
      readonly phase: 'flashing' | 'spinning' | 'settling' | 'revealing' | 'prize-visible';
      readonly sessionId: string;
      readonly selection: TargetSelection;
      readonly plan: SpinPlan;
      /** The prize fell damaged; absent means intact. */
      readonly condition?: ItemState;
    }
  | { readonly phase: 'failed'; readonly failure: SessionFailure };

export type SessionState = SessionData & SessionDetails;
