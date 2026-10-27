import { waitFor } from './cancellation.ts';
import type { ChestDropPort, ChestPreview, ChestPreviewState } from './ports/chest-preview.ts';

export class ChestPreviewController implements ChestPreview {
  private readonly scene: ChestDropPort;
  private readonly unsubscribeErrors: () => void;
  private state: ChestPreviewState = Object.freeze({ phase: 'idle' });
  private readonly listeners = new Set<() => void>();
  private abort?: AbortController;

  constructor(scene: ChestDropPort) {
    this.scene = scene;
    this.unsubscribeErrors = scene.subscribeErrors((error) => this.fail(error));
  }

  readonly getState = (): ChestPreviewState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.state.phase === 'disposed') return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async initialize(): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.phase !== 'failed') return;
    await this.run('loading', async (signal) => {
      await this.invoke(() => this.scene.prepare(signal), signal);
      await this.invoke(() => this.scene.drop(signal), signal);
    });
  }

  async replay(): Promise<void> {
    if (this.state.phase !== 'ready') return;
    await this.run('resetting', async (signal) => {
      await this.invoke(() => this.scene.reset(signal), signal);
      await this.invoke(() => this.scene.drop(signal), signal);
    });
  }

  async retry(): Promise<void> {
    if (this.state.phase === 'failed') await this.initialize();
  }

  dispose(): void {
    if (this.state.phase === 'disposed') return;
    this.abort?.abort();
    this.unsubscribeErrors();
    try {
      this.publish({ phase: 'disposed' });
    } finally {
      this.listeners.clear();
      this.scene.dispose();
    }
  }

  private async run(
    phase: 'loading' | 'resetting',
    operation: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.publish({ phase });
    try {
      abort.signal.throwIfAborted();
      await operation(abort.signal);
      if (!abort.signal.aborted) this.publish({ phase: 'ready' });
    } catch (error) {
      if (this.abort === abort && !abort.signal.aborted) this.fail(error);
    }
  }

  private invoke(invoke: () => Promise<void>, signal: AbortSignal): Promise<void> {
    return waitFor(
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return invoke();
      }),
      signal,
    );
  }

  private fail(error: unknown): void {
    if (this.state.phase === 'disposed') return;
    this.abort?.abort();
    this.publish({
      phase: 'failed',
      message: error instanceof Error ? error.message : 'The scene failed.',
    });
  }

  private publish(state: ChestPreviewState): void {
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) listener();
  }
}
