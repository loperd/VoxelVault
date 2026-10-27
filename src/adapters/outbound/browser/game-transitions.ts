import type { TransitionPresentationPort } from '../../../application/ports/transition-presentation.ts';
import { FrameTimeline } from './frame-timeline.ts';
import type { FrameEnvironment } from './frame-scheduler.ts';
import { CONTENT_EXIT_SECONDS, FLASH_IN_SECONDS, FLASH_OUT_SECONDS } from './scene-timing.ts';

export class GameTransitions implements TransitionPresentationPort {
  readonly element: HTMLDivElement;
  private readonly timeline: FrameTimeline;
  private readonly strip: HTMLElement;
  constructor(environment: FrameEnvironment, strip: HTMLElement) {
    this.timeline = new FrameTimeline(environment);
    this.strip = strip;
    this.element = strip.ownerDocument.createElement('div');
    this.element.className = 'game-flash';
    this.element.setAttribute('aria-hidden', 'true');
    this.element.style.opacity = '0';
  }
  private reducedMotion(): boolean {
    return (
      this.strip.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)')
        .matches ?? false
    );
  }
  clearContent(signal: AbortSignal): Promise<void> {
    this.element.style.opacity = '0';
    return this.timeline.run(this.reducedMotion() ? 0 : CONTENT_EXIT_SECONDS, () => {}, signal);
  }
  flashToRoulette(signal: AbortSignal): Promise<void> {
    const duration = this.reducedMotion() ? 0 : FLASH_IN_SECONDS;
    return this.timeline.run(
      duration,
      (elapsed) => {
        this.element.style.opacity = duration ? String(elapsed / duration) : '0';
      },
      signal,
    );
  }
  finishFlash(signal: AbortSignal): Promise<void> {
    const duration = this.reducedMotion() ? 0 : FLASH_OUT_SECONDS;
    return this.timeline.run(
      duration,
      (elapsed) => {
        this.element.style.opacity = duration ? String(1 - elapsed / duration) : '0';
      },
      signal,
    );
  }
  holdStoppedStrip(signal: AbortSignal): Promise<void> {
    return this.timeline.run(1.2, () => {}, signal);
  }
  async revealPrize(signal: AbortSignal): Promise<void> {
    await this.timeline.run(
      0.6,
      (elapsed) => {
        this.strip.style.opacity = String(1 - elapsed / 0.6);
      },
      signal,
    );
    this.strip.hidden = true;
  }
  resetToIntro(signal: AbortSignal): Promise<void> {
    this.element.style.opacity = '0';
    return this.timeline.run(this.reducedMotion() ? 0 : 0.5, () => {}, signal);
  }
  dispose(): void {
    this.timeline.dispose();
    this.element.remove();
  }
}
