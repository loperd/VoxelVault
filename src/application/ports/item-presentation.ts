import type { ItemState } from '../../domain/case-instance.ts';

/**
 * Items drawn from their 3D models: still previews for lists and the roulette strip (one shared GPU
 * context), and a live view to turn and inspect one item. Items without a model keep their image.
 */
export interface ItemPresentation {
  has(itemId: string): boolean;
  preview(itemId: string, signal: AbortSignal, condition?: ItemState): Promise<HTMLCanvasElement>;
  /** A live view inside `host` until disposed; `onReady` fires with its first frame. */
  inspect(
    host: HTMLElement,
    itemId: string,
    options?: { readonly condition?: ItemState; readonly onReady?: () => void },
  ): ItemInspection;
}

export interface ItemInspection {
  /** Back to the first view. */
  reset(): void;
  dispose(): void;
}
