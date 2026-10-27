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
      readonly returnTo?: 'archive';
    }
  | {
      readonly screen: 'item';
      readonly caseId: string;
      readonly instanceId?: string;
      readonly itemId: string;
      readonly returnTo?: 'archive';
    }
  | {
      readonly screen: 'opening' | 'reward';
      readonly caseId: string;
      readonly instanceId?: string;
      readonly sessionId: string;
      readonly returnTo?: 'archive';
    }
  | { readonly screen: 'not-found' };

export interface Navigation {
  getState(): ScreenRoute;
  subscribe(listener: () => void): () => void;
  go(route: ScreenRoute, replace?: boolean): void;
}
