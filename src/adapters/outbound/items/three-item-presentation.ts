import {
  ACESFilmicToneMapping,
  PMREMGenerator,
  SRGBColorSpace,
  WebGLRenderer,
  type Texture,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type {
  ItemInspection,
  ItemPresentation,
} from '../../../application/ports/item-presentation.ts';
import type { ItemState } from '../../../domain/case-instance.ts';
import { ITEM_VISUALS } from '../../../config/item-visuals.ts';
import { createItemStage } from './item-stage.ts';
import { ItemViewer } from './item-viewer.ts';

const PREVIEW_SIZE = 384,
  CACHE = 32;
/** The preview context is let go this long after the last job: lists draw once, then hold 2D copies. */
const RELEASE_MS = 8000;

/**
 * Item models for every screen. Previews: one WebGL context for the whole page, serial jobs, each
 * copied into a 2D canvas and kept (bounded), so a catalog of sixty items or a roulette strip costs one
 * context and no live scenes. Inspection: a live ItemViewer.
 */
export class ThreeItemPresentation implements ItemPresentation {
  private readonly document: Document;
  private readonly baseUrl: URL;
  private readonly cache = new Map<string, Promise<HTMLCanvasElement>>();
  private queue: Promise<unknown> = Promise.resolve();
  private renderer?: WebGLRenderer;
  private environment?: Texture;
  private release?: ReturnType<typeof setTimeout>;

  constructor(document: Document, baseUrl: URL) {
    this.document = document;
    this.baseUrl = baseUrl;
  }

  has(itemId: string): boolean {
    return Object.hasOwn(ITEM_VISUALS, itemId);
  }

  /** A still of the item's first view. The canvas is shared: draw it, don't change it. */
  preview(
    itemId: string,
    signal: AbortSignal,
    condition: ItemState = 'intact',
  ): Promise<HTMLCanvasElement> {
    const key = `${itemId}:${condition}`;
    let pending = this.cache.get(key);
    if (pending) {
      this.cache.delete(key);
      this.cache.set(key, pending);
    } else {
      // Drawn for whoever asked first; a later caller's abort does not cancel someone else's preview.
      pending = this.queue.then(() => this.draw(itemId, condition));
      this.queue = pending.catch(() => {});
      pending.catch(() => {
        if (this.cache.get(key) === pending) this.cache.delete(key);
      });
      this.cache.set(key, pending);
      while (this.cache.size > CACHE) {
        const [oldest, canvas] = this.cache.entries().next().value!;
        this.cache.delete(oldest);
        void canvas.then(
          (drawn) => {
            drawn.width = drawn.height = 0;
          },
          () => {},
        );
      }
    }
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  inspect(
    host: HTMLElement,
    itemId: string,
    options: { readonly condition?: ItemState; readonly onReady?: () => void } = {},
  ): ItemInspection {
    return new ItemViewer(host, this.baseUrl, itemId, options);
  }

  dispose(): void {
    clearTimeout(this.release);
    this.free();
    for (const pending of this.cache.values())
      void pending.then(
        (canvas) => {
          canvas.width = canvas.height = 0;
        },
        () => {},
      );
    this.cache.clear();
  }

  private async draw(itemId: string, condition: ItemState): Promise<HTMLCanvasElement> {
    clearTimeout(this.release);
    try {
      if (!this.renderer) {
        this.renderer = new WebGLRenderer({
          antialias: true,
          alpha: true,
          preserveDrawingBuffer: true,
        });
        this.renderer.setSize(PREVIEW_SIZE, PREVIEW_SIZE, false);
        this.renderer.setClearColor(0, 0);
        this.renderer.outputColorSpace = SRGBColorSpace;
        this.renderer.toneMapping = ACESFilmicToneMapping;
        const pmrem = new PMREMGenerator(this.renderer);
        this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        pmrem.dispose();
      }
      const renderer = this.renderer;
      const stage = await createItemStage(this.baseUrl, itemId, new AbortController().signal, {
        condition,
        environment: this.environment,
      });
      try {
        stage.frame(1);
        stage.update(0);
        renderer.toneMappingExposure = stage.exposure;
        renderer.render(stage.scene, stage.camera);
        const canvas = this.document.createElement('canvas');
        canvas.width = canvas.height = PREVIEW_SIZE;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas 2D is unavailable.');
        context.drawImage(renderer.domElement, 0, 0);
        return canvas;
      } finally {
        stage.dispose();
      }
    } finally {
      this.release = setTimeout(() => this.free(), RELEASE_MS);
    }
  }

  private free(): void {
    this.environment?.dispose();
    this.environment = undefined;
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = undefined;
  }
}
