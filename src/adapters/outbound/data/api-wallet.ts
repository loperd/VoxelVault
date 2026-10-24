import type { PlayerWallet, WalletBalance, WalletHistory, WalletState, WalletTransaction } from '../../../application/ports/player-wallet.ts';
import { normalizeBaseUrl, resolvePublicAsset } from './asset-url.ts';
import { browserFetch, type FetchJson } from './request-json.ts';
import { DataError } from './data-error.ts';

const units = (v: unknown): string => {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(v) || BigInt(v) > 9223372036854775807n) throw new DataError('INVALID_DTO', 'Invalid whole-unit Wallet amount.');
  return v;
};
const id = (v: unknown): string => { if (typeof v !== 'string' || !v || v.length > 160) throw new DataError('INVALID_DTO', 'Missing Wallet identity.'); return v; };
const record = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new DataError('INVALID_DTO', 'Invalid Wallet response.'); return v as Record<string, unknown>; };

/** Wallet has its own gateway. */
export class ApiWallet implements PlayerWallet {
  private state: WalletState = { loaded: false, balances: [] };
  private generation = 0;
  private readonly baseUrl: URL;
  private readonly listeners = new Set<() => void>();
  private readonly fetcher: FetchJson;
  constructor(baseUrl: string | URL, fetcher: FetchJson = browserFetch) { this.baseUrl = normalizeBaseUrl(baseUrl); this.fetcher = fetcher; }
  reset(): void { this.generation++; this.state = { loaded: false, balances: [] }; this.publish(); }
  readonly getState = () => this.state;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  async load(signal?: AbortSignal): Promise<void> {
    const generation = ++this.generation;
    const dto = record(await this.get('api/v1/wallet', signal));
    const balances: WalletBalance[] = [];
    if (!Array.isArray(dto.balances) || dto.balances.length > 100) throw new DataError('INVALID_DTO', 'Wallet balances must be a list.');
    const seen = new Set<string>();
    for (const value of dto.balances) {
      const b = record(value), asset = id(b.asset), posted = units(b.posted), held = units(b.held), available = units(b.available);
      if (seen.has(asset) || BigInt(posted) - BigInt(held) !== BigInt(available)) throw new DataError('INVALID_DTO', 'Inconsistent Wallet balances.');
      seen.add(asset); balances.push(Object.freeze({ asset, posted, held, available }));
    }
    signal?.throwIfAborted();
    if (generation === this.generation) { this.state = Object.freeze({ loaded: true, balances: Object.freeze(balances) }); this.publish(); }
  }
  async history(asset: string, cursor = '', signal?: AbortSignal): Promise<WalletHistory> {
    const dto = record(await this.get(`api/v1/wallet/transactions?${new URLSearchParams({ asset, cursor, limit: '25' })}`, signal));
    if (!Array.isArray(dto.entries) || dto.entries.length > 100) throw new DataError('INVALID_DTO', 'Invalid Wallet history.');
    const entries: WalletTransaction[] = dto.entries.map(value => {
      const e = record(value);
      if ((e.direction !== 'credit' && e.direction !== 'debit') || e.asset !== asset || typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at))) throw new DataError('INVALID_DTO', 'Invalid transaction.');
      return Object.freeze({ id: id(e.id), asset, direction: e.direction, units: units(e.units), purpose: id(e.purpose), reference: id(e.reference), at: e.at });
    });
    if (dto.nextCursor !== undefined && (typeof dto.nextCursor !== 'string' || dto.nextCursor.length > 2048)) throw new DataError('INVALID_DTO', 'Invalid history cursor.');
    return Object.freeze({ entries: Object.freeze(entries), ...(dto.nextCursor ? { nextCursor: dto.nextCursor as string } : {}) });
  }
  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetcher(resolvePublicAsset(path, this.baseUrl), { signal, cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new DataError('HTTP_ERROR', `Wallet request failed with HTTP ${response.status}.`);
    return response.json();
  }
  private publish(): void { for (const listener of this.listeners) listener(); }
}
