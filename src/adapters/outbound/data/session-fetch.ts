import type { FetchJson } from './request-json.ts';

/**
 * The gateway's access cookie lives minutes, its refresh cookie weeks. A 401 from the API first tries one
 * refresh (shared by every call that hit it at once) and repeats the call; only a refused refresh ends
 * the session. Auth endpoints answer 401 for their own reasons and pass straight through.
 */
export function sessionFetch(fetcher: FetchJson, refreshUrl: string, onExpired: () => void): FetchJson {
  let refreshing: Promise<boolean> | undefined;
  // true: new cookies set; false: refused. A network failure rejects, so an offline player is not signed out.
  const refresh = () => refreshing ??= fetcher(refreshUrl, { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
    .then(response => response.ok)
    .finally(() => { refreshing = undefined; });
  return async (input, init) => {
    const response = await fetcher(input, init);
    if (response.status !== 401 || String(input instanceof Request ? input.url : input).includes('/api/v1/auth/')) return response;
    let refreshed: boolean;
    try { refreshed = await refresh(); } catch { return response; }
    if (refreshed) {
      const again = await fetcher(input, init);
      if (again.status !== 401) return again;
    }
    onExpired();
    return response;
  };
}
