import { createContext, useContext } from 'react';
import type { Navigation, ScreenRoute } from '../../../application/ports/navigation.ts';
import type { ScreenStorage } from '../../outbound/browser/screen-storage.ts';
import { useObservableState } from './use-observable-state.ts';

export const NavigationContext = createContext<{
  navigation?: Navigation;
  storage?: ScreenStorage;
}>({});
const DEFAULT_ROUTE: ScreenRoute = Object.freeze({ screen: 'case', caseId: 'ender' });
const fallback = { getState: () => DEFAULT_ROUTE, subscribe: () => () => {} };
export function useScreenNavigation() {
  const context = useContext(NavigationContext);
  const route = useObservableState(context.navigation ?? fallback);
  return { ...context, route };
}
