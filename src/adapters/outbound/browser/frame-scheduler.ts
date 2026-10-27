export interface FrameEnvironment {
  requestFrame(callback: (timestamp: number) => void): number;
  cancelFrame(id: number): void;
  isHidden(): boolean;
  onVisibilityChange(callback: () => void): () => void;
}

export function browserFrameEnvironment(view: Window, document: Document): FrameEnvironment {
  return {
    requestFrame: (callback) => view.requestAnimationFrame(callback),
    cancelFrame: (id) => view.cancelAnimationFrame(id),
    isHidden: () => document.hidden,
    onVisibilityChange(callback) {
      document.addEventListener('visibilitychange', callback);
      return () => document.removeEventListener('visibilitychange', callback);
    },
  };
}

export class FrameScheduler {
  private readonly environment: FrameEnvironment;
  private readonly update: (deltaSeconds: number) => void;
  private readonly resetClock: () => void;
  private readonly onError: (error: unknown) => void;
  private readonly unsubscribe: () => void;
  private frame?: number;
  private previous?: number;
  private running = false;
  private disposed = false;
  private generation = 0;

  constructor(
    environment: FrameEnvironment,
    update: (deltaSeconds: number) => void,
    resetClock: () => void,
    onError: (error: unknown) => void,
  ) {
    this.environment = environment;
    this.update = update;
    this.resetClock = resetClock;
    this.onError = onError;
    this.unsubscribe = environment.onVisibilityChange(() => {
      this.clearFrame();
      this.previous = undefined;
      this.resetClock();
      this.schedule();
    });
  }

  start(): void {
    if (this.disposed) throw new Error('The frame scheduler has been disposed.');
    if (this.running) return;
    this.running = true;
    this.previous = undefined;
    this.resetClock();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.previous = undefined;
    this.clearFrame();
    this.resetClock();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.unsubscribe();
  }

  private schedule(): void {
    if (!this.running || this.disposed || this.frame !== undefined || this.environment.isHidden())
      return;
    const generation = this.generation;
    this.frame = this.environment.requestFrame((timestamp) => {
      if (generation !== this.generation) return;
      this.frame = undefined;
      if (!this.running || this.disposed || this.environment.isHidden()) return;
      const delta =
        this.previous === undefined ? 0 : Math.max(0, (timestamp - this.previous) / 1000);
      this.previous = timestamp;
      try {
        this.update(delta);
      } catch (error) {
        this.stop();
        this.onError(error);
        return;
      }
      this.schedule();
    });
  }

  private clearFrame(): void {
    this.generation += 1;
    if (this.frame === undefined) return;
    this.environment.cancelFrame(this.frame);
    this.frame = undefined;
  }
}
