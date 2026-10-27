import { CatalogController } from '../application/catalog-controller.ts';
import { ChestPreviewController } from '../application/chest-preview-controller.ts';
import { RouletteController } from '../application/roulette-controller.ts';
import type { ChestPresentationPort } from '../application/ports/chest-presentation.ts';
import type { ChestDropPort, ChestPreview } from '../application/ports/chest-preview.ts';
import type { ItemCatalog } from '../application/ports/item-catalog.ts';
import type { RoulettePresentationPort } from '../application/ports/roulette-presentation.ts';
import type { RouletteSession } from '../application/ports/roulette-session.ts';
import type { TransitionPresentationPort } from '../application/ports/transition-presentation.ts';
import type { CaseOwnership } from '../application/ports/player-inventory.ts';
import type { SessionJournal } from '../application/ports/session-journal.ts';
import type { RandomSource } from '../domain/random-source.ts';
import { browserRandom, createBrowserSessionId } from '../adapters/outbound/browser/identity.ts';
import { FixtureCatalogGateway } from '../adapters/outbound/data/fixture-catalog-gateway.ts';
import { FixtureOutcomeGateway } from '../adapters/outbound/data/fixture-outcome-gateway.ts';
import type { OutcomeGateway } from '../application/ports/outcome-gateway.ts';
import type { CatalogGateway } from '../application/ports/catalog-gateway.ts';
import { copyCatalog, type Item } from '../domain/item.ts';
import type { FetchJson } from '../adapters/outbound/data/request-json.ts';

interface ApplicationOptions {
  readonly baseUrl: string | URL;
  readonly journal?: SessionJournal;
  readonly ownership?: CaseOwnership;
  /** Who decides how an opening ends; without one, a static fixture prize (previews, tests). */
  readonly outcome?: OutcomeGateway;
  readonly catalogPath?: string;
  /** The chest's own contents: the catalog and the roulette show exactly these. */
  readonly contents?: readonly Item[];
  readonly fetcher?: FetchJson;
  readonly random?: RandomSource;
  readonly createSessionId?: () => string;
  readonly chestPreview?: ChestDropPort;
  readonly presentation?: {
    readonly chest: ChestPresentationPort;
    readonly roulette: RoulettePresentationPort;
    readonly transitions: TransitionPresentationPort;
  };
}

export interface Application {
  readonly catalog: ItemCatalog;
  readonly session?: RouletteSession;
  readonly preview?: ChestPreview;
  initialize(): Promise<void>;
  dispose(): void;
}

export function createApplication(options: ApplicationOptions): Application {
  if (options.chestPreview && options.presentation) {
    throw new Error('Preview and gameplay must not both own a chest scene.');
  }
  const gateway: CatalogGateway & { dispose(): void } = options.contents?.length
    ? staticCatalog(options.contents)
    : new FixtureCatalogGateway(options.baseUrl, options.fetcher, options.catalogPath);
  const catalog = new CatalogController(gateway);
  const preview = options.chestPreview
    ? new ChestPreviewController(options.chestPreview)
    : undefined;
  const session = options.presentation
    ? new RouletteController({
        journal: options.journal,
        ownership: options.ownership,
        catalog: gateway,
        outcome: options.outcome ?? new FixtureOutcomeGateway(options.baseUrl, options.fetcher),
        ...options.presentation,
        random: options.random ?? browserRandom,
        createSessionId: options.createSessionId ?? createBrowserSessionId,
      })
    : undefined;
  let disposed = false;

  return {
    catalog,
    session,
    preview,
    async initialize() {
      if (disposed) return;
      await Promise.all([catalog.load(), session?.initialize(), preview?.initialize()]);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const errors: unknown[] = [];
      for (const resource of [session, preview, catalog, gateway]) {
        try {
          resource?.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Failed to dispose the application.');
    },
  };
}

function staticCatalog(items: readonly Item[]): CatalogGateway & { dispose(): void } {
  const catalog = copyCatalog(items);
  return {
    load: async (signal) => {
      signal.throwIfAborted();
      return catalog;
    },
    dispose() {},
  };
}
