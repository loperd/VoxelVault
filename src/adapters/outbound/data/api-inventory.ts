import type { CaseDefinition } from '../../../config/cases.ts';
import { chestLook } from '../../../config/chest-look.ts';
import { claimCase, copyCaseInstance, type CaseInstance } from '../../../domain/case-instance.ts';
import type { MergeOdds, PlayerInventory } from '../../../application/ports/player-inventory.ts';
import type { ChestOutcome } from '../../../application/ports/outcome-gateway.ts';
import { normalizeBaseUrl, resolvePublicAsset } from './asset-url.ts';
import { DataError } from './data-error.ts';
import { decodeItem } from './item-dto.ts';
import { browserFetch, type FetchJson } from './request-json.ts';
import { MutationKeys } from './mutation-key.ts';

/**
 * The player's chests, as the server has them. The server alone issues chests and decides what
 * happens to them; nothing about them is kept in the browser. Opening one claims it for a session
 * (the server lands it) and opens it (the server breaks it or drops an item). The answer is held
 * until the outcome is on screen, so no list shows the prize before the roulette does. A refused
 * request is reported and the list read again from the server.
 */
export class ApiInventory implements PlayerInventory {
  private state: readonly CaseInstance[] = Object.freeze([]);
  private loaded = false;
  private readonly mutations = new MutationKeys();
  private readonly listeners = new Set<() => void>();
  private readonly held = new Map<string, CaseInstance>();
  private readonly baseUrl: URL;
  private readonly cases: readonly CaseDefinition[];
  private readonly fetcher: FetchJson;
  private readonly onError: (error: unknown) => void;

  constructor(
    baseUrl: string | URL,
    cases: readonly CaseDefinition[],
    onError: (error: unknown) => void,
    fetcher: FetchJson = browserFetch,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.cases = cases;
    this.onError = onError;
    this.fetcher = fetcher;
  }

  readonly getState = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** Forget everything read: the session ended, and no one else's (or a past) list may be shown. */
  clear(): void {
    this.state = Object.freeze([]);
    this.held.clear();
    this.loaded = false;
    this.publish();
  }
  /** Has the list been read from the server at least once? */
  isLoaded(): boolean {
    return this.loaded;
  }

  /** Read the player's chests from the server (it issues the starter chests on the first read). */
  async load(signal?: AbortSignal): Promise<void> {
    const response = await this.fetcher(resolvePublicAsset('api/v1/inventory', this.baseUrl), {
      signal,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok)
      throw new DataError(
        'HTTP_ERROR',
        `The inventory request failed with HTTP ${response.status}.`,
      );
    const value: unknown = await response.json();
    if (!Array.isArray(value) || value.length > 10_000)
      throw new DataError('INVALID_DTO', 'The inventory must be a list.');
    this.state = Object.freeze(
      value.flatMap((entry) => {
        const chest = this.decode(entry);
        return chest ? [chest] : [];
      }),
    );
    this.held.clear();
    this.loaded = true;
    this.publish();
  }

  async open(instanceId: string, sessionId: string, signal?: AbortSignal): Promise<ChestOutcome> {
    const current = this.state.find((item) => item.id === instanceId);
    if (!current) throw new Error('Case does not belong to this inventory.');
    const claimed = claimCase(current, sessionId);
    if (claimed !== current) this.replace(claimed);
    try {
      await this.post(instanceId, 'claim', sessionId, signal);
      const answer = await this.post(instanceId, 'open', sessionId, signal);
      const chest =
        answer && typeof answer === 'object'
          ? this.decode((answer as Record<string, unknown>).chest)
          : undefined;
      if (!chest)
        throw new DataError('INVALID_DTO', 'The opening answer has no chest of a known type.');
      if (chest.status === 'destroyed') {
        this.held.set(instanceId, chest);
        return { destroyed: chest.destroyedAt ?? 'opening' };
      }
      if (chest.status !== 'opened' || !chest.reward)
        throw new DataError(
          'INVALID_DTO',
          'The opening answer is neither a prize nor a destruction.',
        );
      this.held.set(instanceId, chest);
      return {
        prize: chest.reward,
        ...(chest.rewardState ? { condition: chest.rewardState } : {}),
      };
    } catch (error) {
      if (!signal?.aborted) {
        this.onError(error);
        // The server is the truth: show what it has.
        void this.load().catch((reloadError) => this.onError(reloadError));
      }
      throw error;
    }
  }

  reveal(instanceId: string): void {
    const chest = this.held.get(instanceId);
    if (!chest) return;
    this.held.delete(instanceId);
    this.replace(chest);
  }

  async mergeOdds(a: string, b: string, signal?: AbortSignal): Promise<MergeOdds> {
    const url = `${resolvePublicAsset('api/v1/inventory/merge', this.baseUrl)}?${new URLSearchParams({ a, b })}`;
    const response = await this.fetcher(url, {
      signal,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok)
      throw new DataError(
        'HTTP_ERROR',
        `The merge odds request failed with HTTP ${response.status}.`,
      );
    return decodeOdds(await response.json());
  }

  async merge(a: string, b: string): Promise<CaseInstance> {
    const intent = JSON.stringify([a, b]);
    try {
      const response = await this.fetcher(
        resolvePublicAsset('api/v1/inventory/merge', this.baseUrl),
        {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          body: JSON.stringify({ a, b }),
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Idempotency-Key': this.mutations.for(intent),
          },
        },
      );
      if (!response.ok)
        throw new DataError(
          'HTTP_ERROR',
          `The chest merge request failed with HTTP ${response.status}.`,
        );
      const chest = this.decode(await response.json());
      if (!chest)
        throw new DataError('INVALID_DTO', 'The merge answer has no chest of a known type.');
      this.mutations.done(intent);
      return chest;
    } catch (error) {
      this.onError(error);
      throw error;
    } finally {
      // Two chests are spent and one is new, or nothing changed: the server says which.
      await this.load().catch((error) => this.onError(error));
    }
  }

  private async post(
    id: string,
    action: 'claim' | 'open',
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.fetcher(
      resolvePublicAsset(`api/v1/inventory/${encodeURIComponent(id)}/${action}`, this.baseUrl),
      {
        method: 'POST',
        signal,
        cache: 'no-store',
        credentials: 'same-origin',
        body: JSON.stringify({ sessionId }),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      },
    );
    if (!response.ok)
      throw new DataError(
        'HTTP_ERROR',
        `The chest ${action} request failed with HTTP ${response.status}.`,
      );
    return response.json();
  }

  private replace(chest: CaseInstance): void {
    this.state = Object.freeze(this.state.map((item) => (item.id === chest.id ? chest : item)));
    this.publish();
  }

  /** A chest from the server; its look is the traits the server froze. */
  private decode(value: unknown): CaseInstance | undefined {
    if (!value || typeof value !== 'object')
      throw new DataError('INVALID_DTO', 'A chest must be an object.');
    const dto = value as Record<string, unknown>;
    const definition = this.cases.find((item) => item.id === dto.caseId);
    // A type this client does not know yet is skipped, not fatal.
    if (!definition) return undefined;
    const seed =
      typeof dto.seed === 'string' &&
      /^(0|[1-9][0-9]{0,19})$/.test(dto.seed) &&
      BigInt(dto.seed) <= 18446744073709551615n
        ? Number(BigInt(dto.seed) & 0xffffffffn)
        : dto.seed;
    if (typeof seed !== 'number' || !Number.isSafeInteger(seed))
      throw new DataError('INVALID_DTO', 'A chest seed must be an integer.');
    if (!Array.isArray(dto.contents) || !Array.isArray(dto.traits))
      throw new DataError('INVALID_DTO', 'A chest needs its contents and traits.');
    const traits = dto.traits as CaseInstance['traits'];
    const drop =
      dto.drop && typeof dto.drop === 'object' ? (dto.drop as Record<string, unknown>) : undefined;
    return copyCaseInstance({
      id: dto.id,
      caseId: dto.caseId,
      status: dto.status,
      appearance: chestLook(definition, seed, traits),
      contents: dto.contents.map((slot) => ({
        item: decodeItem((slot as Record<string, unknown>)?.item, this.baseUrl),
        weight: (slot as Record<string, unknown>)?.weight,
      })),
      traits,
      condition: dto.condition,
      ...(typeof dto.rarity === 'string' && dto.rarity ? { rarity: dto.rarity } : {}),
      ...(typeof dto.sessionId === 'string' && dto.sessionId ? { sessionId: dto.sessionId } : {}),
      ...(drop ? { reward: decodeItem(drop.item, this.baseUrl), rewardState: drop.state } : {}),
      ...(typeof dto.openedAt === 'string' ? { openedAt: dto.openedAt } : {}),
      ...(typeof dto.destroyedAt === 'string' && dto.destroyedAt
        ? { destroyedAt: dto.destroyedAt }
        : {}),
    });
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

const percent = (value: unknown) => {
  if (typeof value !== 'number' || !(value >= 0 && value <= 100))
    throw new DataError('INVALID_DTO', 'A merge chance is a percent.');
  return value;
};
const count = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new DataError('INVALID_DTO', 'A merge count is a whole number.');
  return value as number;
};

function decodeOdds(value: unknown): MergeOdds {
  const dto = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const contents =
    dto.contents && typeof dto.contents === 'object'
      ? (dto.contents as Record<string, unknown>)
      : undefined;
  if (!Array.isArray(dto.traits) || dto.traits.length > 64 || !contents)
    throw new DataError('INVALID_DTO', 'The merge odds need traits and contents.');
  return Object.freeze({
    traits: Object.freeze(
      dto.traits.map((entry) => {
        const trait = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
        if (typeof trait.id !== 'string' || !trait.id)
          throw new DataError('INVALID_DTO', 'A merge trait needs an id.');
        return Object.freeze({
          id: trait.id,
          keep: percent(trait.keep),
          upgrade: percent(trait.upgrade),
        });
      }),
    ),
    contents: Object.freeze({
      total: count(contents.total),
      kept: count(contents.kept),
      keep: percent(contents.keep),
    }),
  });
}
