import { FrameScheduler, type FrameEnvironment } from './frame-scheduler.ts';

/** One cancellable animation; hidden time does not advance it. */
export class FrameTimeline {
  private readonly scheduler: FrameScheduler;
  private task?: { advance(delta: number): void; cancel(error: unknown): void };
  private disposed = false;

  constructor(environment: FrameEnvironment) {
    // These are time-based presentations, not physics steps. Dropping visible time makes a
    // short transition take arbitrarily long under load and trips the phase watchdog.
    // FrameScheduler already excludes hidden-tab time on resume.
    this.scheduler = new FrameScheduler(
      environment,
      (delta) => this.task?.advance(delta),
      () => {},
      (error) => this.cancel(error),
    );
  }

  run(duration: number, update: (elapsed: number) => void, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.disposed) throw new Error('The animation timeline has been disposed.');
    if (!Number.isFinite(duration) || duration < 0) throw new Error('Invalid animation duration.');
    this.cancel(new Error('The animation was replaced.'));
    return new Promise<void>((resolve, reject) => {
      let elapsed = 0,
        completed = false;
      const cleanup = () => {
        this.task = undefined;
        signal.removeEventListener('abort', abort);
        this.scheduler.stop();
      };
      const cancel = (error: unknown) => {
        if (completed) return;
        completed = true;
        cleanup();
        reject(error);
      };
      const abort = () => cancel(signal.reason);
      const advance = (delta: number) => {
        elapsed = Math.min(elapsed + delta, duration);
        update(elapsed);
        if (elapsed >= duration && !completed) {
          completed = true;
          cleanup();
          resolve();
        }
      };
      this.task = { advance, cancel };
      signal.addEventListener('abort', abort, { once: true });
      try {
        advance(0);
        if (!completed) this.scheduler.start();
      } catch (error) {
        cancel(error);
      }
    });
  }

  cancel(error: unknown = new Error('The animation was cancelled.')): void {
    this.task?.cancel(error);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.scheduler.dispose();
  }
}
