import {
  ACESFilmicToneMapping,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import type { CaseDefinition } from '../../../config/cases.ts';
import {
  chestAppearanceKey,
  copyChestAppearance,
  type ChestAppearance,
} from '../../../domain/chest-appearance.ts';
import { loadChestAssets } from './chest-assets.ts';
import { ChestFractureEffects } from './chest-fracture-effects.ts';

type DrawPreview = (
  definition: CaseDefinition,
  appearance: ChestAppearance,
  signal: AbortSignal,
) => Promise<HTMLCanvasElement>;

/** One GPU context, serial jobs, bounded instance-aware cache. No generic poster fallback. */
export class ChestPreviewRenderer {
  private readonly cache = new Map<string, HTMLCanvasElement>();
  private readonly lifetime = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  private renderer?: WebGLRenderer;
  private readonly document: Document;
  private readonly baseUrl: URL;
  private readonly draw: DrawPreview;
  constructor(document: Document, baseUrl: URL, draw?: DrawPreview) {
    this.document = document;
    this.baseUrl = baseUrl;
    this.draw = draw ?? this.drawAsset;
  }
  render(
    definition: CaseDefinition,
    metadata: ChestAppearance,
    signal: AbortSignal,
  ): Promise<HTMLCanvasElement> {
    const appearance = copyChestAppearance(metadata),
      operation = new AbortController();
    const sources = [signal, this.lifetime.signal];
    const abort = () => operation.abort(sources.find((source) => source.aborted)?.reason);
    for (const source of sources) source.addEventListener('abort', abort, { once: true });
    if (sources.some((source) => source.aborted)) abort();
    const combined = operation.signal;
    const key = chestAppearanceKey(
      `${definition.model.path}:${definition.model.revision}:${definition.model.modifications.revision}`,
      appearance,
    );
    const result = this.queue.then(async () => {
      combined.throwIfAborted();
      const cached = this.cache.get(key);
      if (cached) {
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached;
      }
      const canvas = await this.draw(definition, appearance, combined);
      if (combined.aborted) {
        canvas.width = canvas.height = 0;
        combined.throwIfAborted();
      }
      this.cache.set(key, canvas);
      while (this.cache.size > 12) {
        const oldest = this.cache.keys().next().value!;
        const removed = this.cache.get(oldest)!;
        this.cache.delete(oldest);
        removed.width = removed.height = 0;
      }
      return canvas;
    });
    this.queue = result.catch(() => {});
    // Safari on iPhone X has no AbortSignal.any(). Explicit listeners also let completed
    // thumbnail jobs detach from the renderer's lifetime immediately.
    return result.finally(() => {
      for (const source of sources) source.removeEventListener('abort', abort);
    });
  }
  dispose(): void {
    this.lifetime.abort();
    for (const canvas of this.cache.values()) canvas.width = canvas.height = 0;
    this.cache.clear();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = undefined;
  }
  private readonly drawAsset: DrawPreview = async (definition, appearance, signal) => {
    const effectColor = Number.parseInt(definition.presentation.theme.accent.slice(1), 16);
    const assets = await loadChestAssets(
      this.baseUrl,
      signal,
      definition.model,
      appearance,
      effectColor,
    );
    let fractures: ChestFractureEffects | undefined;
    try {
      signal.throwIfAborted();
      if (!this.renderer) {
        this.renderer = new WebGLRenderer({ alpha: true, antialias: true });
        this.renderer.setSize(640, 520, false);
        this.renderer.setClearColor(0, 0);
        this.renderer.toneMapping = ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.2;
      }
      const scene = new Scene();
      scene.add(assets.visual, new HemisphereLight(0xffffff, 0x394858, 2.5));
      const key = new DirectionalLight(0xffffff, 3.5);
      key.position.set(-3, 5, -4);
      scene.add(key);
      fractures = new ChestFractureEffects(
        assets.visual,
        effectColor,
        appearance,
        definition.model.modifications,
      );
      const camera = new PerspectiveCamera(36, 640 / 520, 0.1, 30);
      camera.position.set(-3, 2, -4.5);
      camera.lookAt(0, 0.05, 0);
      this.renderer.render(scene, camera);
      const canvas = this.document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 520;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D is unavailable.');
      context.drawImage(this.renderer.domElement, 0, 0);
      return canvas;
    } finally {
      fractures?.dispose();
      assets.dispose();
    }
  };
}
