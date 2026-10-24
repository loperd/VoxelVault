/** The signed-in player, as the server knows them. Roles are data (Casbin), never a fixed list here. */
export interface Player { readonly id: string; readonly handle: string; readonly displayName: string; readonly roles: readonly string[] }
export interface AuthProviders { readonly passkey: boolean; readonly telegram: boolean }

export type AuthFailure =
  | 'UNAVAILABLE' // the server could not be reached or failed
  | 'HANDLE_TAKEN' | 'INVALID_INPUT' | 'UNKNOWN_ACCOUNT'
  | 'CANCELLED' // the player closed the passkey prompt
  | 'UNSUPPORTED' // this browser has no passkeys
  | 'REJECTED'; // the server did not accept the passkey

export class AuthError extends Error {
  readonly code: AuthFailure;
  constructor(code: AuthFailure, message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'AuthError'; this.code = code;
  }
}

export interface AuthGateway {
  /** The current player, or undefined when nobody is signed in. Throws UNAVAILABLE when the server is down. */
  current(signal?: AbortSignal): Promise<Player | undefined>;
  providers(signal?: AbortSignal): Promise<AuthProviders>;
  register(handle: string, displayName: string): Promise<Player>;
  signIn(handle: string): Promise<Player>;
  /** Where the browser goes to sign in with Telegram (a full-page redirect). */
  readonly telegramUrl: string;
  signOut(): Promise<void>;
}
