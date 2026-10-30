/** The list a case was entered from; back and the highlighted tab lead there. */
export type ReturnTo = 'archive' | 'catalog';

export type ScreenRoute =
  | { readonly screen: 'catalog' }
  | { readonly screen: 'inventory' }
  | { readonly screen: 'archive' }
  | { readonly screen: 'items' }
  | { readonly screen: 'wallet' }
  | {
      readonly screen: 'case';
      readonly caseId: string;
      readonly instanceId?: string;
      readonly returnTo?: ReturnTo;
    }
  | {
      readonly screen: 'item';
      readonly caseId: string;
      readonly instanceId?: string;
      readonly itemId: string;
      readonly returnTo?: ReturnTo;
    }
  | {
      readonly screen: 'opening' | 'reward';
      readonly caseId: string;
      readonly instanceId?: string;
      readonly sessionId: string;
      readonly returnTo?: ReturnTo;
    }
  | { readonly screen: 'not-found' };

export interface Navigation {
  getState(): ScreenRoute;
  subscribe(listener: () => void): () => void;
  go(route: ScreenRoute, replace?: boolean): void;
}
