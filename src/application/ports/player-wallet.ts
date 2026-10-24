export interface WalletBalance { readonly asset: string; readonly posted: string; readonly held: string; readonly available: string }
export interface WalletTransaction { readonly id: string; readonly asset: string; readonly direction: 'debit' | 'credit'; readonly units: string; readonly purpose: string; readonly reference: string; readonly at: string }
export interface WalletHistory { readonly entries: readonly WalletTransaction[]; readonly nextCursor?: string }
export interface WalletState { readonly loaded: boolean; readonly balances: readonly WalletBalance[] }
export interface PlayerWallet {
  getState(): WalletState;
  subscribe(listener: () => void): () => void;
  load(signal?: AbortSignal): Promise<void>;
  history(asset: string, cursor?: string, signal?: AbortSignal): Promise<WalletHistory>;
}
const EMPTY_STATE: WalletState = Object.freeze({ loaded: false, balances: Object.freeze([]) });
export const EMPTY_WALLET = Object.freeze({ getState: () => EMPTY_STATE, subscribe: () => () => {} });
