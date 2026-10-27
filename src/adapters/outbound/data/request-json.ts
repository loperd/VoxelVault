import { DataError } from './data-error.ts';
import { waitFor } from '../../../application/cancellation.ts';

export type FetchJson = typeof fetch;

export const browserFetch: FetchJson = (input, init) => globalThis.fetch(input, init);

export async function requestJson(
  url: string,
  signal: AbortSignal,
  fetcher: FetchJson,
  cache: RequestCache = 'default',
  /** A JSON body makes it a POST (same-origin cookies included: the API knows the player by session). */
  body?: unknown,
): Promise<unknown> {
  signal.throwIfAborted();
  const response = await waitFor(
    fetcher(
      url,
      body === undefined
        ? { signal, cache, headers: { Accept: 'application/json' } }
        : {
            signal,
            cache,
            method: 'POST',
            credentials: 'same-origin',
            body: JSON.stringify(body),
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          },
    ),
    signal,
  );
  signal.throwIfAborted();
  if (!response.ok) {
    throw new DataError('HTTP_ERROR', `The data request failed with HTTP ${response.status}.`);
  }
  try {
    const value: unknown = await waitFor(response.json(), signal);
    signal.throwIfAborted();
    return value;
  } catch (error) {
    signal.throwIfAborted();
    throw new DataError('INVALID_JSON', 'The data response is not valid JSON.', { cause: error });
  }
}
