import { copyCatalog } from '../domain/item.ts';
import { waitFor } from './cancellation.ts';
import type { CatalogGateway } from './ports/catalog-gateway.ts';
import type { CatalogState, ItemCatalog } from './ports/item-catalog.ts';

const EMPTY = Object.freeze([]);

export class CatalogController implements ItemCatalog {
  private readonly gateway: CatalogGateway;
  private state: CatalogState = Object.freeze({ phase: 'idle', items: EMPTY });
  private readonly listeners = new Set<() => void>();
  private abort?: AbortController;
  private loading?: Promise<void>;

  constructor(gateway: CatalogGateway) {
    this.gateway = gateway;
  }

  readonly getState = (): CatalogState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.state.phase === 'disposed') return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  load(): Promise<void> {
    if (this.loading) return this.loading;
    if (this.state.phase !== 'idle' && this.state.phase !== 'failed') return Promise.resolve();
    const abort = new AbortController();
    this.abort = abort;
    this.publish({ phase: 'loading', items: EMPTY });
    if (abort.signal.aborted) return Promise.resolve();
    // Defer invocation so repeated mounts see the same in-flight command.
    this.loading = this.loadItems(abort).finally(() => {
      if (this.abort === abort) this.loading = undefined;
    });
    return this.loading;
  }

  retry(): Promise<void> {
    return this.state.phase === 'failed' ? this.load() : Promise.resolve();
  }

  dispose(): void {
    if (this.state.phase === 'disposed') return;
    this.abort?.abort();
    try {
      this.publish({ phase: 'disposed', items: EMPTY });
    } finally {
      this.listeners.clear();
    }
  }

  private async loadItems(abort: AbortController): Promise<void> {
    try {
      const request = Promise.resolve().then(() => {
        abort.signal.throwIfAborted();
        return this.gateway.load(abort.signal);
      });
      const items = copyCatalog(await waitFor(request, abort.signal));
      if (!abort.signal.aborted) this.publish({ phase: 'ready', items });
    } catch (error) {
      if (!abort.signal.aborted) {
        this.publish({
          phase: 'failed',
          items: EMPTY,
          message: error instanceof Error ? error.message : 'The catalog could not be loaded.',
        });
      }
    }
  }

  private publish(state: CatalogState): void {
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) listener();
  }
}
