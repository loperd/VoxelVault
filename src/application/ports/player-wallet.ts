export interface WalletBalance {
  readonly asset: string;
  readonly posted: string;
  readonly held: string;
  readonly available: string;
}
export interface WalletTransaction {
  readonly id: string;
  readonly asset: string;
  readonly direction: 'debit' | 'credit';
  readonly units: string;
  readonly purpose: string;
  readonly reference: string;
  readonly status: 'held' | 'captured' | 'credited' | 'released';
  readonly at?: string;
}
export interface WalletHistory {
  readonly entries: readonly WalletTransaction[];
  readonly nextCursor?: string;
}
export interface WalletState {
  readonly accountRevision: number;
  readonly loaded: boolean;
  readonly balances: readonly WalletBalance[];
  readonly currencies: readonly WalletCurrency[];
}

export interface WalletCurrency {
  readonly asset: string;
  readonly name: string;
  readonly code: string;
  readonly precision: number;
  readonly canOperate: boolean;
}

export interface TransferRecipient {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
}

export interface TransferCommission {
  readonly ruleId: string;
  readonly version: string;
  readonly imposition: 'inside' | 'outside';
  readonly units: string;
  readonly allocation: readonly {
    readonly accountRef?: string;
    readonly burn?: boolean;
    readonly units: string;
  }[];
}

export interface TransferQuote {
  readonly id: string;
  readonly recipient: TransferRecipient;
  readonly currencyId: string;
  readonly code: string;
  readonly precision: number;
  readonly originalUnits: string;
  readonly debitUnits: string;
  readonly receiptUnits: string;
  readonly commission: readonly TransferCommission[];
  readonly ruleVersion: string;
  readonly expiresAt: string;
}

export interface TransferReceipt {
  readonly transferId: string;
  readonly journalId: string;
  readonly currencyId: string;
  readonly state: 'committed';
  readonly debitUnits: string;
  readonly receiptUnits: string;
}
export interface PlayerWallet {
  getState(): WalletState;
  subscribe(listener: () => void): () => void;
  load(signal?: AbortSignal): Promise<void>;
  history(asset: string, cursor?: string, signal?: AbortSignal): Promise<WalletHistory>;
  resolveRecipient(asset: string, query: string, signal?: AbortSignal): Promise<TransferRecipient>;
  quoteTransfer(
    asset: string,
    recipient: string,
    units: string,
    signal?: AbortSignal,
  ): Promise<TransferQuote>;
  confirmTransfer(quoteId: string, key: string, signal?: AbortSignal): Promise<TransferReceipt>;
}
const EMPTY_STATE: WalletState = Object.freeze({
  accountRevision: 0,
  loaded: false,
  balances: Object.freeze([]),
  currencies: Object.freeze([]),
});
export const EMPTY_WALLET = Object.freeze({
  getState: () => EMPTY_STATE,
  subscribe: () => () => {},
});
