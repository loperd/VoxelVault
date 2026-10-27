import type { Navigation, ScreenRoute } from '../../../application/ports/navigation.ts';
import type { ScreenStorage } from './screen-storage.ts';

export function routePath(route: ScreenRoute): string {
  if (route.screen === 'inventory') return '/inventory';
  if (route.screen === 'archive') return '/archive';
  if (route.screen === 'items') return '/items';
  if (route.screen === 'wallet') return '/wallet';
  if (route.screen === 'catalog') return '/cases';
  if (route.screen === 'not-found') return '/not-found';
  let base = `/cases/${encodeURIComponent(route.caseId)}`;
  if ('instanceId' in route && route.instanceId)
    base += `/instances/${encodeURIComponent(route.instanceId)}`;
  if (route.screen === 'item') base += `/items/${encodeURIComponent(route.itemId)}`;
  else if (route.screen === 'opening' || route.screen === 'reward')
    base += `/${route.screen}/${encodeURIComponent(route.sessionId)}`;
  return 'returnTo' in route && route.returnTo === 'archive' ? `${base}?from=archive` : base;
}
export function parseRoute(path: string): ScreenRoute {
  try {
    const [pathname, query = ''] = path.replace(/^#/, '').split('?');
    const fromArchive = new URLSearchParams(query).get('from') === 'archive';
    const parts = pathname!.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length === 0 || (parts.length === 1 && parts[0] === 'inventory'))
      return { screen: 'inventory' };
    if (parts.length === 1 && parts[0] === 'archive') return { screen: 'archive' };
    if (parts.length === 1 && parts[0] === 'items') return { screen: 'items' };
    if (parts.length === 1 && parts[0] === 'wallet') return { screen: 'wallet' };
    if (parts.length === 1 && parts[0] === 'cases') return { screen: 'catalog' };
    if (parts[0] !== 'cases' || !parts[1] || parts[1].length > 128) return { screen: 'not-found' };
    const owned = parts[2] === 'instances';
    if (owned && (!parts[3] || parts[3].length > 128)) return { screen: 'not-found' };
    const base = {
        caseId: parts[1],
        ...(owned ? { instanceId: parts[3]! } : {}),
        ...(fromArchive ? { returnTo: 'archive' as const } : {}),
      },
      offset = owned ? 4 : 2;
    if (parts.length === offset) return { screen: 'case', ...base };
    if (parts.length !== offset + 2 || !parts[offset + 1] || parts[offset + 1]!.length > 256)
      return { screen: 'not-found' };
    if (parts[offset] === 'items') return { screen: 'item', ...base, itemId: parts[offset + 1]! };
    if (parts[offset] === 'opening' || parts[offset] === 'reward')
      return {
        screen: parts[offset] as 'opening' | 'reward',
        ...base,
        sessionId: parts[offset + 1]!,
      };
  } catch {
    /* Invalid encoded URL. */
  }
  return { screen: 'not-found' };
}

/** Hash routes work on static hosting and retain deployment prefixes and design queries. */
export class BrowserRouter implements Navigation {
  private state: ScreenRoute;
  private readonly listeners = new Set<() => void>();
  private readonly view: Window;
  private readonly storage: ScreenStorage;
  constructor(view: Window, storage: ScreenStorage) {
    this.view = view;
    this.storage = storage;
    const saved = storage.read('navigation', (value) =>
      typeof value === 'string' ? value : '/cases',
    );
    this.state = parseRoute(view.location.hash || saved || '/inventory');
    this.go(this.state, true);
    view.addEventListener('hashchange', this.changed);
    view.addEventListener('popstate', this.changed);
  }
  readonly getState = (): ScreenRoute => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  go(route: ScreenRoute, replace = false): void {
    const path = routePath(route);
    if (this.view.location.hash !== `#${path}`) {
      const url = new URL(this.view.location.href);
      url.hash = path;
      this.view.history[replace ? 'replaceState' : 'pushState'](null, '', url);
    }
    this.accept(parseRoute(path));
  }
  private readonly changed = () => this.accept(parseRoute(this.view.location.hash));
  private accept(route: ScreenRoute): void {
    this.storage.write('navigation', routePath(route));
    if (routePath(this.state) === routePath(route)) return;
    this.state = route;
    for (const listener of [...this.listeners]) listener();
  }
  dispose(): void {
    this.view.removeEventListener('hashchange', this.changed);
    this.view.removeEventListener('popstate', this.changed);
    this.listeners.clear();
  }
}
