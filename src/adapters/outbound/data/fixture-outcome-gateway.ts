import type { ChestOutcome, OutcomeGateway } from '../../../application/ports/outcome-gateway.ts';
import { normalizeBaseUrl, resolvePublicAsset } from './asset-url.ts';
import { decodeItem } from './item-dto.ts';
import { browserFetch, requestJson, type FetchJson } from './request-json.ts';

/** A static prize for chests no server decides about (previews, tests): always the fixture item. */
export class FixtureOutcomeGateway implements OutcomeGateway {
  private readonly baseUrl: URL;
  private readonly fetcher: FetchJson;
  private readonly path: string;

  constructor(
    baseUrl: string | URL,
    fetcher: FetchJson = browserFetch,
    path = 'selected_prize.json',
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetcher = fetcher;
    this.path = path;
  }

  async decide(sessionId: string, signal: AbortSignal): Promise<ChestOutcome> {
    if (!sessionId.trim()) throw new Error('The session id must be nonempty.');
    const value = await requestJson(
      resolvePublicAsset(this.path, this.baseUrl),
      signal,
      this.fetcher,
      'no-store',
    );
    signal.throwIfAborted();
    return { prize: decodeItem(value, this.baseUrl) };
  }
}
