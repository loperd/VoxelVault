import type { ErrorReporter } from '../../../application/ports/error-reporter.ts';

/**
 * Stand-in for Sentry: logs reports and keeps the latest breadcrumbs so a report carries what led
 * up to it. Replace with a Sentry-backed ErrorReporter when it is connected.
 */
export class ConsoleErrorReporter implements ErrorReporter {
  private readonly trail: {
    at: number;
    message: string;
    data?: Readonly<Record<string, unknown>>;
  }[] = [];
  private readonly sink: Pick<Console, 'error' | 'debug'>;
  constructor(sink: Pick<Console, 'error' | 'debug'> = console) {
    this.sink = sink;
  }

  capture(error: unknown, context: Readonly<Record<string, unknown>>): void {
    this.sink.error('[report]', error, { ...context, breadcrumbs: [...this.trail] });
  }

  breadcrumb(message: string, data?: Readonly<Record<string, unknown>>): void {
    this.trail.push({ at: Date.now(), message, ...(data ? { data } : {}) });
    if (this.trail.length > 40) this.trail.shift();
  }
}
