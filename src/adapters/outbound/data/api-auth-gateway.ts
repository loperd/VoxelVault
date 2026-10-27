import {
  AuthError,
  type AuthGateway,
  type AuthProviders,
  type Player,
} from '../../../application/ports/auth-gateway.ts';
import { normalizeBaseUrl, resolvePublicAsset } from './asset-url.ts';
import { browserFetch, type FetchJson } from './request-json.ts';

/**
 * Passkeys and Telegram against the Go API. The session is an HttpOnly cookie the server sets;
 * this side never sees a token. A passkey ceremony is two calls: options (the server's challenge,
 * kept under a ceremony id) and verify (the browser's signed answer, sent with that id).
 */
export class ApiAuthGateway implements AuthGateway {
  private readonly baseUrl: URL;
  private readonly fetcher: FetchJson;
  private readonly credentials: CredentialsContainer | undefined;
  readonly telegramUrl: string;

  constructor(
    baseUrl: string | URL,
    fetcher: FetchJson = browserFetch,
    credentials: CredentialsContainer | undefined = globalThis.navigator?.credentials,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetcher = fetcher;
    this.credentials = credentials;
    this.telegramUrl = this.url('api/v1/auth/telegram/start');
  }

  async current(signal?: AbortSignal): Promise<Player | undefined> {
    const response = await this.send('GET', 'api/v1/me', undefined, signal);
    if (response.status === 401) return undefined;
    return decodePlayer(await this.json(response));
  }

  async providers(signal?: AbortSignal): Promise<AuthProviders> {
    const value = (await this.json(
      await this.send('GET', 'api/v1/auth/config', undefined, signal),
    )) as Record<string, unknown>;
    const passkeys = value.passkeys as { enabled?: boolean } | undefined;
    const telegram = value.telegram as { enabled?: boolean } | undefined;
    return { passkey: passkeys?.enabled === true, telegram: telegram?.enabled === true };
  }

  async register(handle: string, displayName: string): Promise<Player> {
    const begin = await this.send('POST', 'api/v1/auth/passkeys/register/options', {
      handle,
      displayName,
    });
    if (begin.status === 409) throw new AuthError('HANDLE_TAKEN', 'This handle is already taken.');
    if (begin.status === 400)
      throw new AuthError('INVALID_INPUT', 'The handle or name is invalid.');
    const { ceremonyId, options } = await this.ceremony(begin);
    const credential = await this.prompt(() =>
      this.credentials!.create({ publicKey: creationOptions(options) }),
    );
    return this.finish('api/v1/auth/passkeys/register/verify', ceremonyId, credential);
  }

  async signIn(handle: string): Promise<Player> {
    const begin = await this.send('POST', 'api/v1/auth/passkeys/login/options', { handle });
    if (begin.status === 401 || begin.status === 400)
      throw new AuthError('UNKNOWN_ACCOUNT', 'No passkey for this handle.');
    const { ceremonyId, options } = await this.ceremony(begin);
    const credential = await this.prompt(() =>
      this.credentials!.get({ publicKey: requestOptions(options) }),
    );
    return this.finish('api/v1/auth/passkeys/login/verify', ceremonyId, credential);
  }

  async signOut(): Promise<void> {
    const response = await this.send('POST', 'api/v1/auth/logout', undefined);
    if (!response.ok && response.status !== 401)
      throw new AuthError('UNAVAILABLE', `Sign-out failed with HTTP ${response.status}.`);
  }

  private async prompt(run: () => Promise<Credential | null>): Promise<PublicKeyCredential> {
    if (!this.credentials || typeof globalThis.PublicKeyCredential === 'undefined')
      throw new AuthError('UNSUPPORTED', 'Passkeys are not available in this browser.');
    let credential: Credential | null;
    try {
      credential = await run();
    } catch (error) {
      // NotAllowedError: the prompt was dismissed or timed out; nothing to report.
      if (
        error instanceof DOMException &&
        (error.name === 'NotAllowedError' || error.name === 'AbortError')
      )
        throw new AuthError('CANCELLED', 'The passkey prompt was closed.', { cause: error });
      if (error instanceof DOMException && error.name === 'InvalidStateError')
        throw new AuthError('REJECTED', 'This device already has a passkey for the account.', {
          cause: error,
        });
      throw new AuthError('REJECTED', 'The passkey could not be used.', { cause: error });
    }
    if (!credential) throw new AuthError('CANCELLED', 'No passkey was chosen.');
    return credential as PublicKeyCredential;
  }

  private async finish(
    path: string,
    ceremonyId: string,
    credential: PublicKeyCredential,
  ): Promise<Player> {
    const response = await this.send('POST', path, credentialJSON(credential), undefined, {
      'X-Ceremony-ID': ceremonyId,
    });
    if (response.status === 400 || response.status === 401)
      throw new AuthError('REJECTED', 'The server did not accept the passkey.');
    return decodePlayer(await this.json(response));
  }

  private async ceremony(
    response: Response,
  ): Promise<{ ceremonyId: string; options: Record<string, unknown> }> {
    const value = (await this.json(response)) as {
      ceremonyId?: unknown;
      options?: { publicKey?: unknown };
    };
    if (
      typeof value.ceremonyId !== 'string' ||
      !value.options?.publicKey ||
      typeof value.options.publicKey !== 'object'
    ) {
      throw new AuthError('UNAVAILABLE', 'The server sent an invalid passkey challenge.');
    }
    return {
      ceremonyId: value.ceremonyId,
      options: value.options.publicKey as Record<string, unknown>,
    };
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal?: AbortSignal,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    try {
      return await this.fetcher(this.url(path), {
        method,
        signal,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw new AuthError('UNAVAILABLE', 'The server could not be reached.', { cause: error });
    }
  }

  private async json(response: Response): Promise<unknown> {
    if (!response.ok)
      throw new AuthError('UNAVAILABLE', `The server answered HTTP ${response.status}.`);
    try {
      return await response.json();
    } catch (error) {
      throw new AuthError('UNAVAILABLE', 'The server answer is not JSON.', { cause: error });
    }
  }

  private url(path: string) {
    return resolvePublicAsset(path, this.baseUrl);
  }
}

function decodePlayer(value: unknown): Player {
  const dto = value as Record<string, unknown> | null;
  if (
    !dto ||
    typeof dto.id !== 'string' ||
    typeof dto.handle !== 'string' ||
    typeof dto.displayName !== 'string'
  ) {
    throw new AuthError('UNAVAILABLE', 'The server sent an invalid player.');
  }
  const roles = Array.isArray(dto.roles)
    ? dto.roles.filter((role): role is string => typeof role === 'string')
    : [];
  return Object.freeze({
    id: dto.id,
    handle: dto.handle,
    displayName: dto.displayName,
    roles: Object.freeze(roles),
  });
}

// WebAuthn JSON <-> binary. Modern browsers parse the server's JSON themselves; older ones need this.
type JSONStatic = {
  parseCreationOptionsFromJSON?: (value: unknown) => PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON?: (value: unknown) => PublicKeyCredentialRequestOptions;
};
const statics = () => globalThis.PublicKeyCredential as unknown as JSONStatic | undefined;

export function creationOptions(json: Record<string, unknown>): PublicKeyCredentialCreationOptions {
  const native = statics()?.parseCreationOptionsFromJSON;
  if (native) return native(json);
  const user = json.user as Record<string, unknown>;
  return {
    ...json,
    challenge: fromBase64Url(json.challenge as string),
    user: { ...user, id: fromBase64Url(user.id as string) },
    excludeCredentials: ((json.excludeCredentials ?? []) as Record<string, unknown>[]).map(
      (item) => ({ ...item, id: fromBase64Url(item.id as string) }),
    ),
  } as unknown as PublicKeyCredentialCreationOptions;
}

export function requestOptions(json: Record<string, unknown>): PublicKeyCredentialRequestOptions {
  const native = statics()?.parseRequestOptionsFromJSON;
  if (native) return native(json);
  return {
    ...json,
    challenge: fromBase64Url(json.challenge as string),
    allowCredentials: ((json.allowCredentials ?? []) as Record<string, unknown>[]).map((item) => ({
      ...item,
      id: fromBase64Url(item.id as string),
    })),
  } as unknown as PublicKeyCredentialRequestOptions;
}

export function credentialJSON(credential: PublicKeyCredential): unknown {
  const native = (credential as PublicKeyCredential & { toJSON?: () => unknown }).toJSON;
  if (typeof native === 'function') return native.call(credential);
  const response = credential.response as AuthenticatorAttestationResponse &
    AuthenticatorAssertionResponse;
  const encoded: Record<string, string> = { clientDataJSON: toBase64Url(response.clientDataJSON) };
  if ('attestationObject' in response && response.attestationObject)
    encoded.attestationObject = toBase64Url(response.attestationObject);
  if ('authenticatorData' in response && response.authenticatorData)
    encoded.authenticatorData = toBase64Url(response.authenticatorData);
  if ('signature' in response && response.signature)
    encoded.signature = toBase64Url(response.signature);
  if ('userHandle' in response && response.userHandle)
    encoded.userHandle = toBase64Url(response.userHandle);
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response: encoded,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

export function fromBase64Url(value: string): ArrayBuffer {
  const base64 = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64),
    bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function toBase64Url(value: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
