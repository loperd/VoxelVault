import type {
  PlayerWallet,
  WalletBalance,
  WalletHistory,
  WalletState,
  WalletTransaction,
  WalletCurrency,
  TransferRecipient,
  TransferQuote,
  TransferReceipt,
  TransferCommission,
} from '../../../application/ports/player-wallet.ts';
import { normalizeBaseUrl, resolvePublicAsset } from './asset-url.ts';
import { browserFetch, type FetchJson } from './request-json.ts';
import { DataError, type DataErrorCode } from './data-error.ts';

const fail = (code: DataErrorCode, message: string, options?: ErrorOptions) =>
  new DataError(code, message, { ...options, area: 'wallet' });

const units = (v: unknown): string => {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(v) ||
    BigInt(v) > 9223372036854775807n
  )
    throw fail('INVALID_DTO', 'Invalid whole-unit Wallet amount.');
  return v;
};
const id = (v: unknown): string => {
  if (typeof v !== 'string' || !v || v.length > 160)
    throw fail('INVALID_DTO', 'Missing Wallet identity.');
  return v;
};
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw fail('INVALID_DTO', 'Invalid Wallet response.');
  return v as Record<string, unknown>;
};

function precision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 18) {
    throw fail('INVALID_DTO', 'Invalid currency precision.');
  }
  return value;
}

function recipient(value: unknown): TransferRecipient {
  const dto = record(value);
  const text = (value: unknown, max: number): string => {
    if (
      typeof value !== 'string' ||
      !value ||
      value.length > max ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
    ) {
      throw fail('INVALID_DTO', 'Invalid recipient profile.');
    }
    return value;
  };
  return Object.freeze({
    id: id(dto.id),
    handle: text(dto.handle, 162),
    displayName: text(dto.displayName, 160),
  });
}

function commission(value: unknown): TransferCommission {
  const dto = record(value);
  if (
    (dto.imposition !== 'inside' && dto.imposition !== 'outside') ||
    !Array.isArray(dto.allocation) ||
    dto.allocation.length > 100
  ) {
    throw fail('INVALID_DTO', 'Invalid commission.');
  }
  const allocation = dto.allocation.map((value) => {
    const leg = record(value);
    const burn = leg.burn === true;
    if ((leg.burn !== undefined && typeof leg.burn !== 'boolean') || (burn && leg.accountRef)) {
      throw fail('INVALID_DTO', 'Invalid commission destination.');
    }
    const amount = units(leg.units);
    if (amount === '0') throw fail('INVALID_DTO', 'Empty commission allocation.');
    return Object.freeze({
      ...(burn ? { burn: true } : { accountRef: id(leg.accountRef) }),
      units: amount,
    });
  });
  const amount = units(dto.units);
  if (allocation.reduce((total, leg) => total + BigInt(leg.units), 0n) !== BigInt(amount)) {
    throw fail('INVALID_DTO', 'Commission allocation does not balance.');
  }
  return Object.freeze({
    ruleId: id(dto.ruleId),
    version: id(dto.version),
    imposition: dto.imposition,
    units: amount,
    allocation: Object.freeze(allocation),
  });
}

/** Wallet has its own gateway. */
export class ApiWallet implements PlayerWallet {
  private state: WalletState = { accountRevision: 0, loaded: false, balances: [], currencies: [] };
  private generation = 0;
  private accountGeneration = 0;
  private readonly baseUrl: URL;
  private readonly listeners = new Set<() => void>();
  private readonly fetcher: FetchJson;
  constructor(baseUrl: string | URL, fetcher: FetchJson = browserFetch) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetcher = fetcher;
  }
  reset(): void {
    this.generation++;
    this.accountGeneration++;
    this.state = {
      accountRevision: this.accountGeneration,
      loaded: false,
      balances: [],
      currencies: [],
    };
    this.publish();
  }
  readonly getState = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async load(signal?: AbortSignal): Promise<void> {
    const generation = ++this.generation;
    const dto = record(await this.get('api/v1/wallet', signal));
    const balances: WalletBalance[] = [];
    if (!Array.isArray(dto.balances) || dto.balances.length > 100)
      throw fail('INVALID_DTO', 'Wallet balances must be a list.');
    const seen = new Set<string>();
    for (const value of dto.balances) {
      const b = record(value),
        asset = id(b.asset),
        posted = units(b.posted),
        held = units(b.held),
        available = units(b.available);
      if (seen.has(asset) || BigInt(posted) - BigInt(held) !== BigInt(available))
        throw fail('INVALID_DTO', 'Inconsistent Wallet balances.');
      seen.add(asset);
      balances.push(Object.freeze({ asset, posted, held, available }));
    }
    if (!Array.isArray(dto.currencies) || dto.currencies.length !== balances.length) {
      throw fail('INVALID_DTO', 'Missing currency metadata.');
    }
    const currencyIDs = new Set<string>();
    const currencies: WalletCurrency[] = dto.currencies.map((value) => {
      const currency = record(value);
      const asset = id(currency.asset);
      if (!seen.has(asset) || currencyIDs.has(asset) || typeof currency.canOperate !== 'boolean') {
        throw fail('INVALID_DTO', 'Inconsistent currency metadata.');
      }
      currencyIDs.add(asset);
      return Object.freeze({
        asset,
        name: id(currency.name),
        code: id(currency.code),
        precision: precision(currency.precision),
        canOperate: currency.canOperate,
      });
    });
    signal?.throwIfAborted();
    if (generation === this.generation) {
      this.state = Object.freeze({
        accountRevision: this.accountGeneration,
        loaded: true,
        balances: Object.freeze(balances),
        currencies: Object.freeze(currencies),
      });
      this.publish();
    }
  }
  async history(asset: string, cursor = '', signal?: AbortSignal): Promise<WalletHistory> {
    const dto = record(
      await this.get(
        `api/v1/wallet/transactions?${new URLSearchParams({ asset, cursor, limit: '25' })}`,
        signal,
      ),
    );
    if (!Array.isArray(dto.entries) || dto.entries.length > 100)
      throw fail('INVALID_DTO', 'Invalid Wallet history.');
    const entries: WalletTransaction[] = dto.entries.map((value) => {
      const e = record(value);
      if (
        (e.direction !== 'credit' && e.direction !== 'debit') ||
        e.asset !== asset ||
        (e.status !== 'held' &&
          e.status !== 'captured' &&
          e.status !== 'credited' &&
          e.status !== 'released') ||
        (e.status === 'credited' ? e.direction !== 'credit' : e.direction !== 'debit') ||
        (e.at !== undefined && (typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at)))) ||
        (e.at === undefined && (e.status === 'captured' || e.status === 'credited'))
      )
        throw fail('INVALID_DTO', 'Invalid transaction.');
      return Object.freeze({
        id: id(e.id),
        asset,
        direction: e.direction,
        units: units(e.units),
        purpose: id(e.purpose),
        reference: id(e.reference),
        status: e.status,
        ...(e.at === undefined ? {} : { at: e.at as string }),
      });
    });
    if (
      dto.nextCursor !== undefined &&
      (typeof dto.nextCursor !== 'string' || dto.nextCursor.length > 2048)
    )
      throw fail('INVALID_DTO', 'Invalid history cursor.');
    return Object.freeze({
      entries: Object.freeze(entries),
      ...(dto.nextCursor ? { nextCursor: dto.nextCursor as string } : {}),
    });
  }
  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(path, { method: 'GET', signal });
  }

  async resolveRecipient(
    asset: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<TransferRecipient> {
    return recipient(
      await this.get(`api/v1/wallet/recipient?${new URLSearchParams({ asset, query })}`, signal),
    );
  }

  async quoteTransfer(
    asset: string,
    recipientId: string,
    amount: string,
    signal?: AbortSignal,
  ): Promise<TransferQuote> {
    const dto = record(
      await this.request('api/v1/wallet/quotes', {
        method: 'POST',
        body: JSON.stringify({ asset, recipient: recipientId, units: units(amount) }),
        signal,
      }),
    );
    const resolved = recipient(dto.recipient);
    if (
      dto.currencyId !== asset ||
      resolved.id !== recipientId ||
      !Array.isArray(dto.commission) ||
      dto.commission.length === 0 ||
      dto.commission.length > 100 ||
      typeof dto.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(dto.expiresAt))
    ) {
      throw fail('INVALID_DTO', 'Invalid transfer quote.');
    }
    const originalUnits = units(dto.originalUnits);
    const debitUnits = units(dto.debitUnits);
    const receiptUnits = units(dto.receiptUnits);
    if (originalUnits !== amount || debitUnits === '0' || receiptUnits === '0') {
      throw fail('INVALID_DTO', 'Quote does not match the transfer request.');
    }
    const fee = dto.commission.map(commission);
    let debit = BigInt(originalUnits);
    let receipt = debit;
    for (const item of fee) {
      if (item.imposition === 'inside') receipt -= BigInt(item.units);
      else debit += BigInt(item.units);
    }
    if (debit.toString() !== debitUnits || receipt.toString() !== receiptUnits) {
      throw fail('INVALID_DTO', 'Inconsistent transfer quote totals.');
    }
    return Object.freeze({
      id: id(dto.id),
      recipient: resolved,
      currencyId: asset,
      code: id(dto.code),
      precision: precision(dto.precision),
      originalUnits,
      debitUnits,
      receiptUnits,
      commission: Object.freeze(fee),
      ruleVersion: id(dto.ruleVersion),
      expiresAt: dto.expiresAt,
    });
  }

  async confirmTransfer(
    quoteId: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<TransferReceipt> {
    const dto = record(
      await this.request('api/v1/wallet/transfers', {
        method: 'POST',
        body: JSON.stringify({ quoteId }),
        headers: { 'Idempotency-Key': id(key) },
        signal,
      }),
    );
    if (dto.transferId !== quoteId || dto.state !== 'committed') {
      throw fail('INVALID_DTO', 'Missing committed transfer receipt.');
    }
    return Object.freeze({
      transferId: quoteId,
      journalId: id(dto.journalId),
      currencyId: id(dto.currencyId),
      state: 'committed',
      debitUnits: units(dto.debitUnits),
      receiptUnits: units(dto.receiptUnits),
    });
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const generation = this.accountGeneration;
    const response = await this.fetcher(resolvePublicAsset(path, this.baseUrl), {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    const ensureCurrent = () => {
      init.signal?.throwIfAborted();
      if (generation !== this.accountGeneration) {
        throw fail('HTTP_ERROR', 'Аккаунт изменён. Повторите запрос.');
      }
    };
    ensureCurrent();
    if (!response.ok) {
      let code: unknown;
      let cause: unknown;
      try {
        const body: unknown = await response.json();
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          code = (body as Record<string, unknown>).error;
        }
      } catch (error) {
        // The HTTP error remains authoritative even if a proxy returned HTML.
        cause = error;
      }
      ensureCurrent();
      const message: Record<string, string> = {
        quote_expired: 'Котировка истекла. Рассчитайте перевод заново.',
        insufficient_funds: 'Недостаточно средств с учётом комиссии.',
        forbidden: 'Операция недоступна для этой валюты.',
        invalid: 'Проверьте сумму и получателя. Общий налог должен быть ненулевым.',
        conflict: 'Ключ подтверждения уже использован для другого перевода.',
        rate_limited: 'Слишком много запросов. Повторите попытку позже.',
      };
      const translated = typeof code === 'string' ? message[code] : undefined;
      const explanation =
        response.status === 429
          ? 'Слишком много запросов. Повторите попытку позже.'
          : (translated ?? 'Не удалось выполнить запрос. Повторите попытку.');
      throw fail('HTTP_ERROR', explanation, { cause });
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch (cause) {
      ensureCurrent();
      throw fail('INVALID_JSON', 'Сервер вернул некорректный ответ.', { cause });
    }
    ensureCurrent();
    return result;
  }
  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}
