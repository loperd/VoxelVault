import type { Item } from '../../../domain/item.ts';
import { waitFor } from '../../../application/cancellation.ts';
import type { CatalogGateway } from '../../../application/ports/catalog-gateway.ts';
import { normalizeBaseUrl, resolvePublicAsset } from './asset-url.ts';
import { decodeCatalog } from './item-dto.ts';
import { browserFetch, requestJson, type FetchJson } from './request-json.ts';

interface CatalogRequest {
  readonly abort: AbortController;
  readonly promise: Promise<readonly Item[]>;
  consumers: number;
  settled: boolean;
}

/** Catalogs fetched by the warm-up after sign-in, by URL: case screens start from them, no request. */
const warmCatalogs = new Map<string, unknown>();
export function warmCatalog(url: string, value: unknown): void {
  warmCatalogs.set(url, value);
}

export class FixtureCatalogGateway implements CatalogGateway {
  private readonly baseUrl: URL;
  private readonly fetcher: FetchJson;
  private readonly path: string;
  private cached?: readonly Item[];
  private request?: CatalogRequest;
  private disposed = false;

  constructor(baseUrl: string | URL, fetcher: FetchJson = browserFetch, path = 'items.json') {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetcher = fetcher;
    this.path = path;
  }

  async load(signal: AbortSignal): Promise<readonly Item[]> {
    signal.throwIfAborted();
    if (this.disposed) throw new Error('The catalog gateway has been disposed.');
    if (this.cached) return this.cached;
    const request = this.request ?? this.startRequest();
    request.consumers += 1;
    try {
      return await waitFor(request.promise, signal);
    } finally {
      request.consumers -= 1;
      if (request.consumers === 0 && !request.settled) {
        request.abort.abort();
        if (this.request === request) this.request = undefined;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.request?.abort.abort();
    this.request = undefined;
    this.cached = undefined;
  }

  private startRequest(): CatalogRequest {
    const abort = new AbortController();
    const request: CatalogRequest = {
      abort,
      consumers: 0,
      settled: false,
      promise: (warmCatalogs.has(resolvePublicAsset(this.path, this.baseUrl))
        ? Promise.resolve(warmCatalogs.get(resolvePublicAsset(this.path, this.baseUrl)))
        : requestJson(resolvePublicAsset(this.path, this.baseUrl), abort.signal, this.fetcher)
      )
        .then((value) => {
          abort.signal.throwIfAborted();
          const items = decodeCatalog(value, this.baseUrl);
          if (this.request === request && !this.disposed) this.cached = items;
          return items;
        })
        .finally(() => {
          request.settled = true;
          if (this.request === request) this.request = undefined;
        }),
    };
    this.request = request;
    return request;
  }
}
