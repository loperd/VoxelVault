import type {
  ItemsState,
  MergeResult,
  PlayerItems,
  WorkshopAction,
} from '../../../application/ports/player-items.ts';
import { copyOwnedItem, type Amount, type OwnedItem } from '../../../domain/owned-item.ts';
import { waitFor } from '../../../application/cancellation.ts';
import { MutationKeys } from './mutation-key.ts';
import { normalizeBaseUrl, resolvePublicAsset } from './asset-url.ts';
import { DataError, type DataErrorCode } from './data-error.ts';
import { decodeItem } from './item-dto.ts';
import { browserFetch, type FetchJson } from './request-json.ts';

const fail = (code: DataErrorCode, message: string, options?: ErrorOptions) =>
  new DataError(code, message, { ...options, area: 'items' });

const EMPTY: ItemsState = Object.freeze({ loaded: false, items: Object.freeze([]) });
const amount = (v: unknown): Amount => {
  const dto = v as Record<string, unknown> | null;
  const value =
    typeof dto?.value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(dto.value)
      ? Number(dto.value)
      : dto?.value;
  if (
    !dto ||
    typeof dto.resource !== 'string' ||
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  )
    throw fail('INVALID_DTO', 'Invalid item price.');
  return Object.freeze({ resource: dto.resource, value });
};

/**
 * The player's items from Inventory. Prices come with the list; an action is sent,
 * then the list is read again, so the screen always shows what the server has. A refused action
 * is reported and the list read again too.
 */
export class ApiItems implements PlayerItems {
  private readonly mutations = new MutationKeys();
  private state: ItemsState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private readonly baseUrl: URL;
  private readonly fetcher: FetchJson;
  private readonly onError: (error: unknown) => void;

  constructor(
    baseUrl: string | URL,
    onError: (error: unknown) => void,
    fetcher: FetchJson = browserFetch,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
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

  async load(signal?: AbortSignal): Promise<void> {
    const response = await this.fetcher(
      resolvePublicAsset('api/v1/inventory/items', this.baseUrl),
      {
        signal,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      },
    );
    if (!response.ok)
      throw fail('HTTP_ERROR', `The items request failed with HTTP ${response.status}.`);
    const value = (await response.json()) as Record<string, unknown> | null;
    if (!value || !Array.isArray(value.items) || value.items.length > 10_000)
      throw fail('INVALID_DTO', 'The items answer needs a list of items.');
    const items = value.items.flatMap((entry) => {
      const item = this.decode(entry);
      return item ? [item] : [];
    });
    this.state = Object.freeze({ loaded: true, items: Object.freeze(items) });
    this.publish();
  }

  async work(itemId: string, action: WorkshopAction): Promise<Amount> {
    return amount(
      await this.act(`api/v1/inventory/items/${encodeURIComponent(itemId)}/${action}`, undefined, {
        itemId,
        action,
      }),
    );
  }

  async merge(a: string, b: string): Promise<MergeResult> {
    const before = this.state.items.filter((item) => item.id === a || item.id === b);
    const kept = this.decode(await this.act('api/v1/inventory/items/merge', { a, b }));
    if (!kept) throw fail('INVALID_DTO', 'The merge answer is not an item this client knows.');
    const was = before.find((item) => item.id === kept.id);
    return Object.freeze({ kept, mended: !!was && was.state !== kept.state });
  }

  /** Send an action; the list is read again whatever the answer. */
  private async act(
    path: string,
    body: unknown,
    expected?: { itemId: string; action: WorkshopAction },
  ): Promise<unknown> {
    const intent = JSON.stringify([path, body]);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(fail('OPERATION_PENDING', 'The operation is still being confirmed.')),
      40_000,
    );
    try {
      const response = await waitFor(
        this.fetcher(resolvePublicAsset(path, this.baseUrl), {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          body: JSON.stringify(body ?? {}),
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Idempotency-Key': this.mutations.for(intent),
          },
        }),
        controller.signal,
      );
      if (!response.ok)
        throw fail('HTTP_ERROR', `The item request failed with HTTP ${response.status}.`);
      let answer: unknown = await waitFor(response.json(), controller.signal);
      if (response.status === 202) {
        if (!expected) throw fail('INVALID_DTO', 'Unexpected asynchronous merge.');
        const first = answer as Record<string, unknown>;
        if (typeof first?.operationId !== 'string' || !/^[0-9a-f]{64}$/.test(first.operationId))
          throw fail('INVALID_DTO', 'Invalid operation identity.');
        const id = first.operationId;
        for (;;) {
          const op = answer as Record<string, unknown>;
          if (
            op?.operationId !== id ||
            op.itemId !== expected.itemId ||
            op.action !== expected.action
          )
            throw fail('INVALID_DTO', 'Operation scope changed.');
          if (op.stage === 'completed') {
            const q = op.quote as Record<string, unknown>;
            answer = { resource: q?.asset, value: q?.units };
            break;
          }
          if (op.stage === 'canceled' || op.stage === 'restored') {
            this.mutations.done(intent);
            throw fail('OPERATION_REJECTED', 'The operation was canceled.');
          }
          if (op.stage === 'reconciliation_required')
            throw fail('OPERATION_PENDING', 'The operation needs confirmation.');
          if (
            ![
              'awaiting_funds',
              'repair_committed',
              'awaiting_award',
              'canceling',
              'closing',
            ].includes(op.stage as string)
          )
            throw fail('INVALID_DTO', 'Unknown operation stage.');
          await waitFor(new Promise((resolve) => setTimeout(resolve, 350)), controller.signal);
          const next = await waitFor(
            this.fetcher(resolvePublicAsset(`api/v1/inventory/operations/${id}`, this.baseUrl), {
              signal: controller.signal,
              cache: 'no-store',
              credentials: 'same-origin',
            }),
            controller.signal,
          );
          if (!next.ok) throw fail('OPERATION_PENDING', 'Operation confirmation is unavailable.');
          answer = await waitFor(next.json(), controller.signal);
        }
      }
      this.mutations.done(intent);
      return answer;
    } catch (error) {
      this.onError(error);
      throw error;
    } finally {
      clearTimeout(timeout);
      void this.load().catch((error) => this.onError(error));
    }
  }

  /** An item the rulebook no longer describes (no rarity) is skipped, not fatal. */
  private decode(value: unknown): OwnedItem | undefined {
    if (!value || typeof value !== 'object')
      throw fail('INVALID_DTO', 'An item must be an object.');
    const dto = value as Record<string, unknown>;
    const described = dto.item as Record<string, unknown> | undefined;
    if (!described || typeof described.type !== 'string' || !described.type) return undefined;
    const offers = dto.offers as Record<string, unknown> | undefined;
    return copyOwnedItem({
      id: dto.id as string,
      item: decodeItem(described, this.baseUrl),
      state: dto.state as OwnedItem['state'],
      origin: dto.origin as string,
      ...(dto.status === 'locked' || dto.status === 'available' ? { status: dto.status } : {}),
      ...(typeof dto.operationId === 'string' ? { operationId: dto.operationId } : {}),
      ...(offers
        ? {
            offers: {
              ...(offers.repair ? { repair: amount(offers.repair) } : {}),
              salvage: amount(offers.salvage),
              sell: amount(offers.sell),
              mergeRepair: offers.mergeRepair as number,
              ...(typeof offers.mergeWith === 'string' && offers.mergeWith
                ? { mergeWith: offers.mergeWith }
                : {}),
            },
          }
        : {}),
    });
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
