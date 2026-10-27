import type { Navigation, ScreenRoute } from '../../../application/ports/navigation.ts';
import { useContext } from 'react';
import { NavigationContext } from './NavigationContext.tsx';
import { useObservableState } from './use-observable-state.ts';
import { Button } from './Button.tsx';

const HOME: ScreenRoute = Object.freeze({ screen: 'inventory' });
const noNavigation = { getState: () => HOME, subscribe: () => () => {} };

/** A visible way home; never adds a redundant action to the main menu itself. */
export function MainMenuButton({ navigation: supplied }: { readonly navigation?: Navigation }) {
  const context = useContext(NavigationContext);
  const navigation = supplied ?? context.navigation;
  const route = useObservableState(navigation ?? noNavigation);
  if (!navigation || route.screen === 'inventory') return null;
  return (
    <Button variant="transparent" onClick={() => navigation.go(HOME)}>
      В главное меню
    </Button>
  );
}
