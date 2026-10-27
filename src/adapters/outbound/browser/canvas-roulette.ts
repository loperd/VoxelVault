import type { RoulettePresentationPort } from '../../../application/ports/roulette-presentation.ts';
import type { Item, Rarity } from '../../../domain/item.ts';
import { positionAt, velocityAt, type SpinPlan } from '../../../domain/spin-plan.ts';
import { assertTarget, type TargetSelection } from '../../../domain/strip.ts';
import { CASE_RARITY_PALETTES } from '../../../config/cases.ts';
import { waitFor } from '../../../application/cancellation.ts';
import { browserFrameEnvironment, type FrameEnvironment } from './frame-scheduler.ts';
import { FrameTimeline } from './frame-timeline.ts';
import type { ClickSound } from './click-sound.ts';

/** Card proportions, all relative to the canvas band height, so every viewport gets the same strip. */
const CARD_HEIGHT = 0.82,
  CARD_ASPECT = 0.8,
  GAP = 0.1;
/** Cards shrink and dim with distance from the pointer; the stopped card grows into its lock. */
const SIDE_SCALE = 0.86,
  LOCK_SCALE = 1.05;
export const LOCK_SECONDS = 0.5;
const RARITY_LABELS: Readonly<Record<Rarity, string>> = {
  common: 'Обычный',
  uncommon: 'Необычный',
  rare: 'Редкий',
  epic: 'Эпический',
  legendary: 'Легендарный',
};
/** Rarer cards carry more light: glow strength and rays. */
const RARITY_LIGHT: Readonly<Record<Rarity, number>> = {
  common: 0.35,
  uncommon: 0.5,
  rare: 0.65,
  epic: 0.82,
  legendary: 1,
};

export type RouletteCue = 'wind-up' | 'lock';

export interface CanvasRouletteOptions {
  readonly environment?: FrameEnvironment;
  /** `tick(rate)`: a card centre crossed the pointer; the rate follows the strip's speed. */
  readonly sound?: Pick<ClickSound, 'tick' | 'stop'>;
  /** The strip starts to draw back, or the prize card locks under the pointer. */
  readonly cue?: (cue: RouletteCue) => void;
  readonly createCanvas?: () => HTMLCanvasElement;
  readonly loadImage?: (url: string, signal: AbortSignal) => Promise<HTMLImageElement>;
  /** The item's own picture (a still of its 3D model), or undefined to load `item.image`. */
  readonly art?: (item: Item, signal: AbortSignal) => Promise<CardArt> | undefined;
}

type CardArt = HTMLImageElement | HTMLCanvasElement;
const sizeOf = (image: CardArt): [number, number] =>
  'naturalWidth' in image
    ? [image.naturalWidth || image.width, image.naturalHeight || image.height]
    : [image.width, image.height];

interface Geometry {
  readonly width: number;
  readonly height: number;
  readonly ratio: number;
  readonly cardWidth: number;
  readonly cardHeight: number;
  readonly stride: number;
}

/**
 * One canvas band; the pointer is the band's horizontal centre. A card's centre sits at
 * `width / 2 + (slot + 0.5 - position) * stride`, so the plan's end position (a slot centre) puts
 * the prize card's centre exactly under the pointer at any size. `data-state` on the element is
 * `spinning` or `locked` for the surrounding scene's light.
 */
export class CanvasRoulette implements RoulettePresentationPort {
  readonly element: HTMLCanvasElement;
  private readonly document: Document;
  private readonly timeline: FrameTimeline;
  private readonly options: CanvasRouletteOptions;
  private readonly images = new Map<string, { item: Item; image: CardArt }>();
  private readonly cards = new Map<string, HTMLCanvasElement>();
  private readonly overlays = new Map<string, HTMLCanvasElement>();
  private context?: CanvasRenderingContext2D;
  private selection?: TargetSelection;
  private strip: readonly string[] = [];
  private operation?: AbortController;
  private observer?: ResizeObserver;
  private detachResize?: () => void;
  private geometry?: Geometry;
  private font = 'system-ui, sans-serif';
  private position = 0;
  private speed = 0;
  /** 0..1 while the stopped card locks in; undefined while it moves. */
  private lock?: number;
  private generation = 0;
  private disposed = false;
  private sizeDirty = true;

  constructor(document: Document, options: CanvasRouletteOptions = {}) {
    if (!document.defaultView) throw new Error('The roulette requires a browser window.');
    this.document = document;
    this.options = options;
    this.element = this.createCanvas();
    this.element.className = 'roulette roulette--canvas';
    this.element.hidden = true;
    this.element.setAttribute('aria-hidden', 'true');
    this.timeline = new FrameTimeline(
      options.environment ?? browserFrameEnvironment(document.defaultView, document),
    );
  }

  async prepare(signal: AbortSignal): Promise<void> {
    this.assertAlive(signal);
    if (this.context) return;
    this.context = this.getContext(this.element);
    const resize = () => {
      this.sizeDirty = true;
      if (!this.disposed) this.paint();
    };
    const Observer = (this.document.defaultView as Window & typeof globalThis).ResizeObserver;
    if (Observer) {
      this.observer = new Observer(resize);
      this.observer.observe(this.element);
    }
    this.document.defaultView!.addEventListener('resize', resize);
    this.detachResize = () => this.document.defaultView!.removeEventListener('resize', resize);
  }

  async spin(selection: TargetSelection, plan: SpinPlan, signal: AbortSignal): Promise<void> {
    this.assertAlive(signal);
    assertTarget(selection);
    if (plan.slotCount !== selection.slots.length || plan.targetIndex !== selection.targetIndex) {
      throw new Error('The spin plan does not match its target.');
    }
    const generation = ++this.generation;
    this.operation?.abort(new Error('The animation was replaced.'));
    this.timeline.cancel(new Error('The animation was replaced.'));
    const operation = new AbortController();
    this.operation = operation;
    const abort = () => operation.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    this.options.sound?.stop();
    this.element.hidden = true;
    this.selection = undefined;
    this.strip = [];
    try {
      await this.prepare(operation.signal);
      await this.prepareCards(selection, operation.signal);
      this.assertAlive(operation.signal);
      this.selection = selection;
      this.position = plan.startPosition;
      this.speed = 0;
      this.lock = undefined;
      this.strip = selection.slots.map((slot) => this.key(slot.item));
      this.element.hidden = false;
      this.element.style.opacity = '1';
      this.element.dataset.state = 'spinning';
      this.sizeDirty = true;
      const reducedMotion = this.document.defaultView!.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      if (!reducedMotion) this.options.cue?.('wind-up');
      // One timeline for travel and lock, so no frame is lost between them. Ticks when a card's
      // centre crosses the pointer.
      let previousCentre = Math.floor(this.position - 0.5);
      await this.timeline.run(
        reducedMotion ? 0 : plan.durationSeconds + LOCK_SECONDS,
        (elapsed) => {
          const at = reducedMotion ? plan.durationSeconds : Math.min(elapsed, plan.durationSeconds);
          this.position = positionAt(plan, at);
          this.speed = velocityAt(plan, at);
          const centre = Math.floor(this.position - 0.5);
          if (!reducedMotion && centre !== previousCentre)
            this.options.sound?.tick(0.8 + Math.min(0.5, Math.abs(this.speed) / 40));
          previousCentre = centre;
          if (at >= plan.durationSeconds) {
            if (this.lock === undefined) {
              this.element.dataset.state = 'locked';
              this.options.cue?.('lock');
            }
            this.lock = reducedMotion
              ? 1
              : Math.min(1, (elapsed - plan.durationSeconds) / LOCK_SECONDS);
          }
          this.paint();
        },
        operation.signal,
      );
    } catch (error) {
      if (generation === this.generation) this.reset();
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      if (this.operation === operation) this.operation = undefined;
    }
  }

  async prepareSpin(selection: TargetSelection, signal: AbortSignal): Promise<void> {
    this.assertAlive(signal);
    assertTarget(selection);
    await this.prepare(signal);
    await this.prepareCards(selection, signal);
  }

  reset(): void {
    this.generation += 1;
    this.operation?.abort(new Error('The animation was cancelled.'));
    this.operation = undefined;
    this.timeline.cancel();
    this.options.sound?.stop();
    this.selection = undefined;
    this.strip = [];
    this.lock = undefined;
    this.speed = 0;
    delete this.element.dataset.state;
    this.element.hidden = true;
    this.element.style.opacity = '1';
    if (this.geometry) this.context?.clearRect(0, 0, this.geometry.width, this.geometry.height);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
    this.timeline.dispose();
    this.observer?.disconnect();
    this.observer = undefined;
    this.detachResize?.();
    this.detachResize = undefined;
    this.releaseCards();
    this.images.clear();
    this.element.width = 0;
    this.element.height = 0;
    this.context = undefined;
    this.element.remove();
  }

  private async prepareCards(selection: TargetSelection, signal: AbortSignal): Promise<void> {
    const items = [
      ...new Map(selection.slots.map((slot) => [this.key(slot.item), slot.item])).values(),
    ];
    const wanted = new Set(items.map((item) => this.key(item)));
    for (const key of this.images.keys())
      if (!wanted.has(key)) {
        this.images.delete(key);
        this.release(this.cards.get(key));
        this.cards.delete(key);
      }
    const queue = items.filter((item) => !this.images.has(this.key(item)));
    await Promise.all(
      Array.from({ length: Math.min(queue.length, 4) }, async () => {
        while (queue.length) {
          signal.throwIfAborted();
          const item = queue.shift()!;
          const image = await waitFor(
            this.options.art?.(item, signal) ??
              (this.options.loadImage ?? this.loadImage)(item.image, signal),
            signal,
          );
          signal.throwIfAborted();
          if (sizeOf(image).some((side) => side <= 0)) {
            throw new Error(`The prize image ${item.id} has no dimensions.`);
          }
          this.images.set(this.key(item), { item, image });
        }
      }),
    );
  }

  private paint(): void {
    if (!this.context || !this.selection || this.disposed) return;
    const ratio = Math.min(this.document.defaultView!.devicePixelRatio || 1, 2);
    if (this.sizeDirty || this.geometry?.ratio !== ratio) {
      // Layout reads belong to resize/show, never the animation's frame loop.
      const bounds =
        this.element.clientWidth && this.element.clientHeight
          ? undefined
          : this.element.getBoundingClientRect();
      const width = this.element.clientWidth || bounds!.width;
      const height = this.element.clientHeight || bounds!.height;
      if (width <= 0 || height <= 0) return;
      this.sizeDirty = false;
      if (
        this.geometry?.width !== width ||
        this.geometry.height !== height ||
        this.geometry.ratio !== ratio
      ) {
        const cardHeight = Math.round(height * CARD_HEIGHT),
          cardWidth = Math.round(cardHeight * CARD_ASPECT);
        this.geometry = {
          width,
          height,
          ratio,
          cardWidth,
          cardHeight,
          stride: Math.round(cardWidth * (1 + GAP)),
        };
        this.element.width = Math.ceil(width * ratio);
        this.element.height = Math.ceil(height * ratio);
        this.font =
          this.document.defaultView!.getComputedStyle?.(this.element).fontFamily || this.font;
        // Card surfaces are drawn once per size, never in the frame loop.
        this.releaseCards();
      }
    }
    const context = this.context,
      { width, height, ratio: scale } = this.geometry!;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    this.drawStrip();
  }

  private drawStrip(): void {
    const selection = this.selection!,
      context = this.context!,
      { width, height, cardWidth, cardHeight, stride } = this.geometry!;
    const count = selection.slots.length,
      lock = this.lock === undefined ? 0 : 1 - (1 - this.lock) ** 3;
    // Motion smear: ghost copies trail a fast card; none at rest, so the stopped strip is sharp.
    const smear = Math.min(1, Math.max(0, (Math.abs(this.speed) - 4) / 14));
    const trail =
      Math.sign(this.speed) * Math.min(stride * 0.3, (Math.abs(this.speed) / 60) * stride * 0.45);
    const reach = Math.ceil((width / 2 + cardWidth) / stride);
    const nearest = Math.round(this.position - 0.5);
    for (let logical = nearest - reach; logical <= nearest + reach; logical++) {
      const key = this.strip[((logical % count) + count) % count]!;
      const offset = logical + 0.5 - this.position,
        distance = Math.abs(offset),
        focused = distance < 0.5;
      const size =
        (SIDE_SCALE + (1 - SIDE_SCALE) * Math.exp(-distance * distance * 1.6)) *
        (focused ? 1 + (LOCK_SCALE - 1) * lock : 1);
      const w = cardWidth * size,
        h = cardHeight * size,
        x = width / 2 + offset * stride - w / 2,
        y = (height - h) / 2;
      if (x > width || x + w < 0) continue;
      const opacity = 1 - Math.min(0.55, distance * 0.17 + (focused ? 0 : 0.3 * lock));
      const card = this.card(key);
      for (let ghost = 2; ghost >= 1 && smear > 0; ghost--) {
        context.globalAlpha = (opacity * smear * 0.2) / ghost;
        context.drawImage(card, x + trail * ghost, y, w, h);
      }
      context.globalAlpha = opacity;
      context.drawImage(card, x, y, w, h);
      // The card nearest the pointer lights up as it passes; the stopped card stays lit and flashes once.
      const focus = Math.max(0, 1 - distance * 2) * (this.lock === undefined ? 0.6 : 1);
      if (focus > 0.02) {
        context.globalAlpha = focus;
        context.drawImage(this.overlay(`glow:${this.images.get(key)!.item.rarity}`), x, y, w, h);
      }
      if (focused && this.lock !== undefined && lock < 1) {
        context.globalAlpha = 0.75 * (1 - lock);
        context.drawImage(this.overlay('flash'), x, y, w, h);
      }
    }
    context.globalAlpha = 1;
  }

  private card(key: string): HTMLCanvasElement {
    let card = this.cards.get(key);
    if (!card) {
      const { item, image } = this.images.get(key)!;
      card = this.drawCard(item, image);
      this.cards.set(key, card);
    }
    return card;
  }

  private overlay(kind: string): HTMLCanvasElement {
    let overlay = this.overlays.get(kind);
    if (!overlay) {
      const { canvas, context, w, h } = this.surface();
      this.cardPath(context, w, h);
      if (kind === 'flash') {
        context.fillStyle = '#ffffff';
        context.fill();
      } else {
        const palette = CASE_RARITY_PALETTES[kind.slice(5) as Rarity];
        context.save();
        context.clip();
        context.shadowColor = palette.primary;
        context.shadowBlur = w * 0.12;
        context.strokeStyle = palette.highlight;
        context.lineWidth = Math.max(2, w * 0.018);
        this.cardPath(context, w, h, context.lineWidth / 2);
        context.stroke();
        context.restore();
      }
      overlay = canvas;
      this.overlays.set(kind, overlay);
    }
    return overlay;
  }

  /** The reward card: rarity-lit layers behind the item, a pedestal, a rarity band and a bevel. */
  private drawCard(item: Item, image: CardArt): HTMLCanvasElement {
    const { canvas, context, w, h } = this.surface();
    const palette = CASE_RARITY_PALETTES[item.rarity],
      light = RARITY_LIGHT[item.rarity];
    context.save();
    this.cardPath(context, w, h);
    context.clip();
    const base = context.createLinearGradient(0, 0, 0, h);
    base.addColorStop(0, mix(palette.deep, '#0a1016', 0.45));
    base.addColorStop(0.62, '#0b1218');
    base.addColorStop(1, '#06090d');
    context.fillStyle = base;
    context.fillRect(0, 0, w, h);
    // Rays from behind the item, stronger for rarer rewards.
    const cx = w / 2,
      cy = h * 0.42;
    context.globalAlpha = 0.05 + 0.1 * light;
    context.fillStyle = palette.highlight;
    for (let ray = 0; ray < 12; ray++) {
      const angle = (ray / 12) * Math.PI * 2,
        spread = 0.08;
      context.beginPath();
      context.moveTo(cx, cy);
      context.lineTo(cx + Math.cos(angle - spread) * h, cy + Math.sin(angle - spread) * h);
      context.lineTo(cx + Math.cos(angle + spread) * h, cy + Math.sin(angle + spread) * h);
      context.closePath();
      context.fill();
    }
    context.globalAlpha = 1;
    const glow = context.createRadialGradient(cx, cy, 0, cx, cy, w * 0.62);
    glow.addColorStop(0, withAlpha(palette.primary, 0.3 + 0.4 * light));
    glow.addColorStop(1, withAlpha(palette.primary, 0));
    context.fillStyle = glow;
    context.fillRect(0, 0, w, h);
    // Enchantment dust: a fixed pixel scatter (seeded by the item, so a card never shimmers).
    let seed = [...item.id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
    const pixel = Math.max(2, Math.round(w / 48));
    context.fillStyle = palette.highlight;
    for (let dot = 0; dot < 18; dot++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const px = ((seed % 1000) / 1000) * w;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const py = ((seed % 1000) / 1000) * h * 0.7;
      context.globalAlpha = 0.12 + (0.25 * light * (seed % 7)) / 7;
      context.fillRect(
        Math.round(px / pixel) * pixel,
        Math.round(py / pixel) * pixel,
        pixel,
        pixel,
      );
    }
    context.globalAlpha = 1;
    // Pedestal: the item stands on a lit disc.
    context.fillStyle = '#00000080';
    context.beginPath();
    context.ellipse(cx, h * 0.7, w * 0.3, h * 0.045, 0, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = withAlpha(palette.highlight, 0.55);
    context.lineWidth = Math.max(1, w / 120);
    context.beginPath();
    context.ellipse(cx, h * 0.69, w * 0.27, h * 0.035, 0, 0, Math.PI * 2);
    context.stroke();
    const [width, height] = sizeOf(image);
    const fit = Math.min((w * 0.64) / width, (h * 0.5) / height),
      iw = width * fit,
      ih = height * fit;
    context.shadowColor = '#000000b3';
    context.shadowBlur = w * 0.06;
    context.shadowOffsetY = h * 0.025;
    context.drawImage(image, cx - iw / 2, h * 0.68 - ih, iw, ih);
    context.shadowColor = 'transparent';
    // Rarity band and label.
    const band = context.createLinearGradient(0, 0, w, 0);
    band.addColorStop(0, withAlpha(palette.primary, 0.15));
    band.addColorStop(0.5, palette.primary);
    band.addColorStop(1, withAlpha(palette.primary, 0.15));
    context.fillStyle = band;
    context.fillRect(0, h - h * 0.035, w, h * 0.035);
    context.fillStyle = palette.highlight;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `650 ${Math.round(h * 0.058)}px ${this.font}`;
    context.fillText(RARITY_LABELS[item.rarity].toUpperCase(), cx, h * 0.86);
    // Bevel: lit top edge, shaded bottom edge, a sheen over the top third.
    const sheen = context.createLinearGradient(0, 0, 0, h * 0.35);
    sheen.addColorStop(0, '#ffffff1f');
    sheen.addColorStop(1, '#ffffff00');
    context.fillStyle = sheen;
    context.fillRect(0, 0, w, h * 0.35);
    context.restore();
    context.lineWidth = Math.max(1.5, w / 90);
    context.strokeStyle = withAlpha(palette.primary, 0.35 + 0.35 * light);
    this.cardPath(context, w, h, context.lineWidth / 2);
    context.stroke();
    return canvas;
  }

  /** An offscreen surface at card size and device ratio, drawn in card units. */
  private surface() {
    const { cardWidth: w, cardHeight: h, ratio } = this.geometry!;
    const canvas = this.createCanvas(),
      scale = ratio * LOCK_SCALE; // sharp at the lock's enlargement too
    canvas.width = Math.ceil(w * scale);
    canvas.height = Math.ceil(h * scale);
    const context = this.getContext(canvas);
    context.scale(scale, scale);
    return { canvas, context, w, h };
  }

  /** A rectangle with cut (pixel) corners. */
  private cardPath(context: CanvasRenderingContext2D, w: number, h: number, inset = 0): void {
    const cut = Math.max(3, Math.round(w * 0.045)) + inset * 0.4,
      l = inset,
      t = inset,
      r = w - inset,
      b = h - inset;
    context.beginPath();
    context.moveTo(l + cut, t);
    context.lineTo(r - cut, t);
    context.lineTo(r, t + cut);
    context.lineTo(r, b - cut);
    context.lineTo(r - cut, b);
    context.lineTo(l + cut, b);
    context.lineTo(l, b - cut);
    context.lineTo(l, t + cut);
    context.closePath();
  }

  private readonly loadImage = (url: string, signal: AbortSignal): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const image = this.document.createElement('img');
      const cleanup = () => {
        image.onload = null;
        image.onerror = null;
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        image.src = '';
        reject(signal.reason);
      };
      image.onload = () => {
        cleanup();
        resolve(image);
      };
      image.onerror = () => {
        cleanup();
        reject(new Error(`The roulette image could not be loaded: ${url}`));
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      image.src = url;
    });

  private key(item: Item): string {
    return JSON.stringify([item.id, item.image, item.rarity]);
  }
  private createCanvas(): HTMLCanvasElement {
    return this.options.createCanvas?.() ?? this.document.createElement('canvas');
  }
  private getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is not available.');
    return context;
  }
  private release(canvas?: HTMLCanvasElement): void {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  private releaseCards(): void {
    for (const canvas of [...this.cards.values(), ...this.overlays.values()]) this.release(canvas);
    this.cards.clear();
    this.overlays.clear();
  }
  private assertAlive(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.disposed) throw new Error('The roulette has been disposed.');
  }
}

function withAlpha(hex: string, alpha: number): string {
  return `${hex.slice(0, 7)}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`;
}

function mix(a: string, b: string, share: number): string {
  const channel = (hex: string, index: number) =>
    Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return `#${[0, 1, 2]
    .map((index) =>
      Math.round(channel(a, index) * share + channel(b, index) * (1 - share))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
