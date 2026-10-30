import type { FetchJson } from './request-json.ts';

export type Connection = 'ok' | 'internet-down' | 'server-down';

/** Two independent hosts that answer an empty 204: if either replies, the player's internet works. */
const INTERNET_PROBES = [
  'https://www.gstatic.com/generate_204',
  'https://cp.cloudflare.com/generate_204',
];

async function reaches(fetcher: FetchJson, url: string, timeoutMs: number, sameOrigin: boolean) {
  try {
    const response = await fetcher(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      // Cross-origin hosts send no CORS headers; an opaque answer still proves they were reached.
      ...(sameOrigin ? {} : { mode: 'no-cors' as const }),
    });
    return !sameOrigin || response.status < 500;
  } catch {
    return false;
  }
}

/**
 * The server answering is the only thing that matters ('ok'). If it does not, the two public hosts tell
 * whether the fault is the player's internet or our server.
 * shortcut: a region that blocks both public hosts reads a dead server as 'internet-down'; the message
 * for both asks for the same thing (wait, refresh), so no third probe.
 */
export async function checkConnection(
  serverUrl: string,
  fetcher: FetchJson,
  timeoutMs = 4000,
): Promise<Connection> {
  const [server, ...internet] = await Promise.all([
    reaches(fetcher, serverUrl, timeoutMs, true),
    ...INTERNET_PROBES.map((url) => reaches(fetcher, url, timeoutMs, false)),
  ]);
  if (server) return 'ok';
  return internet.some(Boolean) ? 'server-down' : 'internet-down';
}

/**
 * Holds the connection state. `suspect` (a request failed, the browser went online) runs one check at a
 * time; while the state is not 'ok' it re-checks on a timer so the notice clears itself.
 */
export function createConnectionMonitor(check: () => Promise<Connection>, recheckMs = 5000) {
  let state: Connection = 'ok';
  const listeners = new Set<() => void>();
  let probing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = (next: Connection) => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const probe = () =>
    (probing ??= check()
      .then(set)
      .finally(() => {
        probing = undefined;
        clearTimeout(timer);
        timer = state === 'ok' ? undefined : setTimeout(probe, recheckMs);
      }));
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    suspect() {
      void probe();
    },
    /** The browser's own offline event is certain: show it now, the check keeps watching. */
    offline() {
      set('internet-down');
      void probe();
    },
  };
}

export type ConnectionMonitor = ReturnType<typeof createConnectionMonitor>;

/** Reports a network failure or a 5xx to the monitor; the call's own result is untouched. */
export function watchedFetch(fetcher: FetchJson, onTrouble: () => void): FetchJson {
  return async (input, init) => {
    try {
      const response = await fetcher(input, init);
      if (response.status >= 500) onTrouble();
      return response;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) onTrouble();
      throw error;
    }
  };
}
