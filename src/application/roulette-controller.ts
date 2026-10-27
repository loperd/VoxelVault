import { DomainError } from '../domain/error.ts';
import { copyCatalog, copyItem, type Item } from '../domain/item.ts';
import type { RandomSource } from '../domain/random-source.ts';
import {
  assertSpinSettings,
  createSpinPlan,
  DEFAULT_SPIN_SETTINGS,
  type SpinSettings,
} from '../domain/spin-plan.ts';
import { buildStrip, ensureTarget, type StripSlot } from '../domain/strip.ts';
import { waitFor } from './cancellation.ts';
import type { CatalogGateway } from './ports/catalog-gateway.ts';
import type { ChestPresentationPort } from './ports/chest-presentation.ts';
import type { ChestOutcome, OutcomeGateway } from './ports/outcome-gateway.ts';
import { BREAK_MOMENTS } from '../domain/chest-breakage.ts';
import { ITEM_STATES, type ItemState } from '../domain/case-instance.ts';
import type { RoulettePresentationPort } from './ports/roulette-presentation.ts';
import type { RouletteSession } from './ports/roulette-session.ts';
import type { TransitionPresentationPort } from './ports/transition-presentation.ts';
import type { CaseOwnership } from './ports/player-inventory.ts';
import type { SessionJournal, SessionCheckpoint } from './ports/session-journal.ts';
import type { RecoveryAction, SessionDetails, SessionState } from './session-state.ts';

export interface ControllerDependencies {
  readonly journal?: SessionJournal;
  readonly ownership?: CaseOwnership;
  readonly catalog: CatalogGateway;
  /** The server's decision for a session: the prize, or that the chest breaks and when. */
  readonly outcome: OutcomeGateway;
  readonly chest: ChestPresentationPort;
  readonly roulette: RoulettePresentationPort;
  readonly transitions: TransitionPresentationPort;
  readonly random: RandomSource;
  /** Must return a unique, nonempty id for each new opening. */
  readonly createSessionId: () => string;
}

export interface ControllerSettings {
  readonly capacity?: number;
  readonly spin?: SpinSettings;
}

interface Operation {
  readonly abort: AbortController;
}

const EMPTY = Object.freeze([]);

export class RouletteController implements RouletteSession {
  private readonly dependencies: ControllerDependencies;
  private readonly capacity: number;
  private readonly spinSettings: SpinSettings;
  private catalog: readonly Item[] = EMPTY;
  private slots: readonly StripSlot[] = EMPTY;
  private state: SessionState = Object.freeze({ phase: 'idle', catalog: EMPTY, slots: EMPTY });
  private readonly listeners = new Set<() => void>();
  private operation?: Operation;
  private sessionId?: string;
  private outcome?: ChestOutcome;
  private readonly unsubscribeErrors?: () => void;

  constructor(dependencies: ControllerDependencies, settings: ControllerSettings = {}) {
    this.dependencies = dependencies;
    this.capacity = settings.capacity ?? 40;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) {
      throw new DomainError('INVALID_CAPACITY', 'Strip capacity must be a positive integer.');
    }
    this.spinSettings = Object.freeze({ ...(settings.spin ?? DEFAULT_SPIN_SETTINGS) });
    assertSpinSettings(this.spinSettings);
    this.unsubscribeErrors = dependencies.chest.subscribeErrors?.((error) => {
      if (this.state.phase === 'disposed' || this.state.phase === 'failed') return;
      this.operation?.abort.abort();
      this.operation = undefined;
      this.dependencies.roulette.reset();
      this.publish({
        phase: 'failed',
        failure: Object.freeze({
          code: 'PRESENTATION_FAILED',
          message: error instanceof Error ? error.message : 'The chest scene failed.',
          phase: this.state.phase,
          recovery: 'initialize',
        }),
      });
    });
  }

  readonly getState = (): SessionState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.state.phase === 'disposed') return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async initialize(): Promise<void> {
    if (
      this.state.phase !== 'idle' &&
      !(this.state.phase === 'failed' && this.state.failure.recovery === 'initialize')
    )
      return;

    const checkpoint = this.dependencies.journal?.load();
    this.catalog = EMPTY;
    this.slots = EMPTY;
    this.outcome = undefined;
    this.sessionId = undefined;
    await this.run('loading', 'initialize', async (operation) => {
      const [items] = await Promise.all([
        this.invoke(operation, () => this.dependencies.catalog.load(operation.abort.signal)).then(
          copyCatalog,
        ),
        this.invoke(operation, () => this.dependencies.chest.prepare(operation.abort.signal)),
        this.invoke(operation, () => this.dependencies.roulette.prepare(operation.abort.signal)),
      ]);
      if (!this.isCurrent(operation)) return;
      const slots = buildStrip(items, this.capacity, this.dependencies.random);
      this.catalog = items;
      this.slots = slots;
      const chest = this.dependencies.chest;
      if (chest.preview) await this.invoke(operation, () => chest.preview!(operation.abort.signal));
      else chest.hide();
      if (this.isCurrent(operation)) this.publish({ phase: 'ready' });
    });
    if (checkpoint && this.getState().phase === 'ready') {
      this.sessionId = checkpoint.sessionId;
      if (checkpoint.stage === 'destroyed') {
        // Already decided and shown: restore the outcome, never replay it as a new roll.
        this.dependencies.chest.hide();
        this.dependencies.ownership?.reveal(checkpoint.sessionId);
        this.publish({ phase: 'destroyed', sessionId: checkpoint.sessionId });
        return;
      }
      this.outcome =
        checkpoint.stage === 'chest'
          ? checkpoint.outcome
          : {
              prize: checkpoint.selection.prize,
              ...(checkpoint.condition ? { condition: checkpoint.condition } : {}),
            };
      if (checkpoint.stage === 'chest') await this.startOpening(false);
      else {
        this.slots = checkpoint.selection.slots;
        this.dependencies.chest.hide();
        if (checkpoint.stage === 'prize') this.publish({ phase: 'prize-visible', ...checkpoint });
        else
          await this.run('clearing', 'open', (operation) =>
            this.presentRoulette(operation, checkpoint),
          );
      }
    }
  }

  async openChest(): Promise<void> {
    if (this.state.phase !== 'ready') return;
    this.outcome = undefined;
    this.sessionId = this.dependencies.createSessionId();
    if (!this.sessionId.trim()) throw new Error('The session id must be nonempty.');
    await this.startOpening(false);
  }

  async closePrize(): Promise<void> {
    if (this.state.phase !== 'prize-visible' && this.state.phase !== 'destroyed') return;
    await this.reset();
  }

  async retry(): Promise<void> {
    if (this.state.phase !== 'failed') return;
    switch (this.state.failure.recovery) {
      case 'initialize':
        await this.initialize();
        break;
      case 'open':
        await this.startOpening(true);
        break;
      case 'reset':
        await this.reset();
        break;
    }
  }

  async resetAfterError(): Promise<void> {
    if (this.state.phase !== 'failed' || this.state.failure.recovery === 'initialize') return;
    await this.reset();
  }

  dispose(): void {
    if (this.state.phase === 'disposed') return;
    this.operation?.abort.abort();
    this.unsubscribeErrors?.();
    this.operation = undefined;
    this.catalog = EMPTY;
    this.slots = EMPTY;
    this.outcome = undefined;
    this.sessionId = undefined;
    const errors: unknown[] = [];
    try {
      this.publish({ phase: 'disposed' });
    } catch (error) {
      errors.push(error);
    }
    this.listeners.clear();
    for (const port of [
      this.dependencies.chest,
      this.dependencies.roulette,
      this.dependencies.transitions,
    ]) {
      try {
        port.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'Failed to dispose presentation resources.');
  }

  /**
   * The server's outcome comes first, while the screen clears: the fall and the opening are drawn
   * from it (a chest that breaks on impact never opens; one that breaks while opening bursts
   * instead of spinning a roulette).
   */
  private async startOpening(replay: boolean): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    await this.run('clearing', 'open', async (operation) => {
      if (replay) {
        this.dependencies.roulette.reset();
        await this.invoke(operation, () => this.dependencies.chest.reset(operation.abort.signal));
      }
      const outcomeTask = this.outcome
        ? Promise.resolve(this.outcome)
        : this.invoke(operation, () =>
            this.dependencies.outcome.decide(sessionId, operation.abort.signal),
          ).then((value) => {
            const outcome = copyOutcome(value);
            if (this.isCurrent(operation)) {
              this.outcome = outcome;
              this.saveCheckpoint();
            }
            return outcome;
          });
      const [outcome] = await Promise.all([
        outcomeTask,
        this.invoke(operation, () =>
          this.dependencies.transitions.clearContent(operation.abort.signal),
        ),
        this.dependencies.chest.stageForDrop
          ? this.invoke(operation, () =>
              this.dependencies.chest.stageForDrop!(operation.abort.signal),
            )
          : Promise.resolve(),
      ]);
      if (!this.isCurrent(operation)) return;
      this.publish({ phase: 'dropping', sessionId });
      await this.invoke(operation, () => this.dependencies.chest.drop(operation.abort.signal));
      if (!this.isCurrent(operation)) return;
      // Destroyed on landing: nothing is left to open.
      if ('destroyed' in outcome && outcome.destroyed === 'impact') {
        this.showDestroyed(sessionId);
        return;
      }
      this.publish({ phase: 'opening', sessionId });
      await this.invoke(operation, () => this.dependencies.chest.open(operation.abort.signal));
      if (!this.isCurrent(operation)) return;
      if ('destroyed' in outcome) {
        this.showDestroyed(sessionId);
        return;
      }
      const selection = ensureTarget(this.slots, outcome.prize, this.dependencies.random);
      const plan = createSpinPlan(selection, this.spinSettings);
      this.slots = selection.slots;
      await this.presentRoulette(operation, {
        sessionId,
        selection,
        plan,
        ...(outcome.condition ? { condition: outcome.condition } : {}),
      });
    });
  }

  private showDestroyed(sessionId: string): void {
    this.dependencies.ownership?.reveal(sessionId);
    this.publish({ phase: 'destroyed', sessionId });
  }

  private async presentRoulette(
    operation: Operation,
    payload: {
      sessionId: string;
      selection: import('../domain/strip.ts').TargetSelection;
      plan: import('../domain/spin-plan.ts').SpinPlan;
      condition?: ItemState;
    },
  ): Promise<void> {
    const { selection, plan } = payload;
    const roulette = this.dependencies.roulette;
    if (roulette.prepareSpin)
      await this.invoke(operation, () => roulette.prepareSpin!(selection, operation.abort.signal));
    if (!this.isCurrent(operation)) return;
    this.publish({ phase: 'flashing', ...payload });
    await this.invoke(operation, () =>
      this.dependencies.transitions.flashToRoulette(operation.abort.signal),
    );
    if (!this.isCurrent(operation)) return;
    this.dependencies.chest.hide();
    this.publish({ phase: 'spinning', ...payload });
    await Promise.all([
      this.invoke(operation, () =>
        this.dependencies.roulette.spin(selection, plan, operation.abort.signal),
      ),
      this.invoke(operation, () =>
        this.dependencies.transitions.finishFlash(operation.abort.signal),
      ),
    ]);
    if (!this.isCurrent(operation)) return;
    this.publish({ phase: 'settling', ...payload });
    await this.invoke(operation, () =>
      this.dependencies.transitions.holdStoppedStrip(operation.abort.signal),
    );
    if (!this.isCurrent(operation)) return;
    this.publish({ phase: 'revealing', ...payload });
    await this.invoke(operation, () =>
      this.dependencies.transitions.revealPrize(operation.abort.signal),
    );
    if (this.isCurrent(operation)) {
      this.dependencies.ownership?.reveal(payload.sessionId);
      this.publish({ phase: 'prize-visible', ...payload });
    }
  }

  private async reset(): Promise<void> {
    this.dependencies.journal?.clear();
    await this.run('resetting', 'reset', async (operation) => {
      this.dependencies.roulette.reset();
      await Promise.all([
        this.invoke(operation, () => this.dependencies.chest.reset(operation.abort.signal)),
        this.invoke(operation, () =>
          this.dependencies.transitions.resetToIntro(operation.abort.signal),
        ),
      ]);
      const chest = this.dependencies.chest;
      if (chest.preview) await this.invoke(operation, () => chest.preview!(operation.abort.signal));
      else chest.hide();
      if (!this.isCurrent(operation)) return;
      this.outcome = undefined;
      this.sessionId = undefined;
      this.publish({ phase: 'ready' });
    });
  }

  private async run(
    phase: 'loading' | 'clearing' | 'resetting',
    recovery: RecoveryAction,
    work: (operation: Operation) => Promise<void>,
  ): Promise<void> {
    this.operation?.abort.abort();
    const operation: Operation = { abort: new AbortController() };
    this.operation = operation;
    if (phase === 'clearing') this.publish({ phase, sessionId: this.sessionId! });
    else this.publish({ phase });
    if (!this.isCurrent(operation)) return;
    try {
      await work(operation);
    } catch (error) {
      if (!this.isCurrent(operation)) return;
      const failure = Object.freeze({
        code: error instanceof DomainError ? error.code : 'OPERATION_FAILED',
        message: error instanceof Error ? error.message : 'An operation failed.',
        phase: this.state.phase,
        recovery,
      });
      operation.abort.abort();
      this.operation = undefined;
      this.publish({ phase: 'failed', failure });
    }
  }

  private invoke<T>(operation: Operation, invoke: () => Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(() => {
      operation.abort.signal.throwIfAborted();
      return invoke();
    });
    return waitFor(promise, operation.abort.signal);
  }

  private isCurrent(operation: Operation): boolean {
    return (
      this.operation === operation &&
      !operation.abort.signal.aborted &&
      this.state.phase !== 'disposed'
    );
  }

  private saveCheckpoint(): void {
    const state = this.state;
    if (
      !this.sessionId ||
      !this.dependencies.journal ||
      (state.phase === 'failed' && state.failure.recovery === 'reset')
    )
      return;
    let checkpoint: SessionCheckpoint;
    if (state.phase === 'destroyed') checkpoint = { stage: 'destroyed', sessionId: this.sessionId };
    else if ('selection' in state)
      checkpoint = {
        stage: state.phase === 'prize-visible' ? 'prize' : 'roulette',
        sessionId: this.sessionId,
        selection: state.selection,
        plan: state.plan,
        ...(state.condition ? { condition: state.condition } : {}),
      };
    else
      checkpoint = {
        stage: 'chest',
        sessionId: this.sessionId,
        ...(this.outcome ? { outcome: this.outcome } : {}),
      };
    this.dependencies.journal.save(checkpoint);
  }

  private publish(details: SessionDetails): void {
    this.state = Object.freeze({ ...details, catalog: this.catalog, slots: this.slots });
    if (!['idle', 'loading', 'ready', 'resetting', 'disposed'].includes(details.phase))
      this.saveCheckpoint();
    for (const listener of [...this.listeners]) listener();
  }
}

function copyOutcome(value: ChestOutcome): ChestOutcome {
  if (value && typeof value === 'object' && 'prize' in value) {
    if (value.condition !== undefined && !ITEM_STATES.includes(value.condition))
      throw new DomainError('INVALID_OUTCOME', 'The prize state is not supported.');
    return Object.freeze({
      prize: copyItem(value.prize),
      ...(value.condition ? { condition: value.condition } : {}),
    });
  }
  if (
    value &&
    typeof value === 'object' &&
    'destroyed' in value &&
    BREAK_MOMENTS.includes(value.destroyed)
  ) {
    return Object.freeze({ destroyed: value.destroyed });
  }
  throw new DomainError('INVALID_OUTCOME', 'An opening ends in a prize or a destruction.');
}
