import type { ScreenRoute } from './ports/navigation.ts';

/**
 * The project's single navigation map. Every "back" (Escape, back buttons, leaving a finished
 * opening) walks one step up this map and stops at the main screen. The archive is a section the
 * player opens on purpose; nothing ever navigates there by itself.
 *
 *   inventory (main)
 *   ├── items      (the items dropped from chests)
 *   ├── wallet     (balances and transactions)
 *   ├── archive
 *   ├── catalog
 *   └── case ── item
 *              └── opening / reward   (owned by the session: closing them returns to the case)
 */
export const MAIN_SCREEN = 'inventory' as const;

/** One step back; undefined on the main screen. */
export function parentRoute(route: ScreenRoute): ScreenRoute | undefined {
  switch (route.screen) {
    case 'inventory':
      return undefined;
    case 'archive':
    case 'items':
    case 'wallet':
    case 'catalog':
    case 'not-found':
      return { screen: MAIN_SCREEN };
    case 'case':
      return { screen: route.returnTo ?? MAIN_SCREEN };
    case 'item':
    case 'opening':
    case 'reward':
      return {
        screen: 'case',
        caseId: route.caseId,
        ...(route.instanceId ? { instanceId: route.instanceId } : {}),
        ...('returnTo' in route && route.returnTo ? { returnTo: route.returnTo } : {}),
      };
  }
}
