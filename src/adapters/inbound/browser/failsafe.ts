import type { ErrorReporter } from '../../../application/ports/error-reporter.ts';
import type { SessionState } from '../../../application/session-state.ts';

/**
 * The player must never be left hanging. Anything unexpected — an uncaught error, a rejected
 * promise nobody handles, a session phase that never ends, a runtime rebuilding in a loop — is
 * reported and answered with one modal: what happened, "На главную" and "Перезагрузить".
 *
 * The modal is plain DOM outside React, so it still works when the React tree is the thing that
 * broke. Time limits count only while the tab is visible (animation frames pause in background
 * tabs; that is not a hang).
 */
type Phase = SessionState['phase'];
export interface WatchedSession {
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
}

/** Longest a phase may last (visible seconds) before it counts as a hang. Others are open-ended. */
export const PHASE_LIMITS: Partial<Record<Phase, number>> = {
  loading: 30,
  clearing: 15,
  dropping: 25,
  opening: 25,
  flashing: 15,
  spinning: 45,
  settling: 15,
  revealing: 15,
  resetting: 20,
};
const DEFAULT_COPY = {
  title: 'Сундук завис',
  text: 'Мы уже знаем об ошибке. Ваши сундуки и награды на месте — можно вернуться на главную или перезагрузить страницу.',
};
/** Dialog wording by the area an error names; no area keeps the chest-scene copy of the markup. */
const AREA_COPY: Record<string, { title: string; text: string }> = {
  wallet: {
    title: 'Кошелёк не отвечает',
    text: 'Не удалось связаться с кошельком. После перезагрузки проверьте баланс и историю операций.',
  },
  inventory: {
    title: 'Не загрузился инвентарь',
    text: 'Не удалось получить ваши сундуки. Перезагрузите страницу, чтобы повторить.',
  },
  items: {
    title: 'Не загрузились предметы',
    text: 'Не удалось получить ваши предметы. Перезагрузите страницу, чтобы повторить.',
  },
};

/** More rebuilds of the same case runtime than this within the window is a render loop. */
const REBUILD_LIMIT = 6,
  REBUILD_WINDOW = 3000;

export interface FailsafeOptions {
  readonly document: Document;
  readonly reporter: ErrorReporter;
  /** Leave whatever is broken: navigate to the main screen. */
  readonly goHome: () => void;
  readonly isHome?: () => boolean;
  readonly reload?: () => void;
  readonly now?: () => number;
  readonly limits?: Partial<Record<Phase, number>>;
}

export class Failsafe {
  private readonly options: FailsafeOptions;
  private readonly limits: Partial<Record<Phase, number>>;
  private readonly now: () => number;
  private dialog?: HTMLDialogElement;
  private open = false;
  private readonly rebuilds = new Map<string, number[]>();
  private readonly cleanups: (() => void)[] = [];

  constructor(options: FailsafeOptions) {
    this.options = options;
    this.limits = { ...PHASE_LIMITS, ...options.limits };
    this.now = options.now ?? (() => Date.now());
  }

  /** Global safety net: uncaught errors and unhandled rejections. */
  install(): () => void {
    const view = this.options.document.defaultView;
    if (!view) return () => {};
    const onError = (event: ErrorEvent) =>
      this.fatal('UNCAUGHT_ERROR', event.error ?? event.message, {
        source: event.filename,
        line: event.lineno,
      });
    const onRejection = (event: PromiseRejectionEvent) =>
      this.fatal('UNHANDLED_REJECTION', event.reason);
    view.addEventListener('error', onError);
    view.addEventListener('unhandledrejection', onRejection);
    const remove = () => {
      view.removeEventListener('error', onError);
      view.removeEventListener('unhandledrejection', onRejection);
    };
    this.cleanups.push(remove);
    return remove;
  }

  /**
   * Watches one session: reports every failure it reaches, and treats a phase that outlives its
   * limit as a hang. `tick` advances the watchdog (one second by default, driven by setInterval).
   */
  watch(
    session: WatchedSession,
    context: Readonly<Record<string, unknown>>,
    interval = 1000,
  ): () => void {
    let phase = session.getState().phase,
      visibleFor = 0,
      last = this.now(),
      fired = false;
    const document = this.options.document;
    const onChange = () => {
      const state = session.getState();
      if (state.phase === phase) return;
      this.options.reporter.breadcrumb(`session ${phase} → ${state.phase}`, context);
      phase = state.phase;
      visibleFor = 0;
      last = this.now();
      fired = false;
      if (state.phase === 'failed') {
        // Expected, recoverable failures have their own screen; they are still tracked.
        this.options.reporter.capture(new Error(state.failure.message), {
          ...context,
          code: state.failure.code,
          phase: state.failure.phase,
          recovery: state.failure.recovery,
        });
      }
    };
    const unsubscribe = session.subscribe(onChange);
    const tick = () => {
      const time = this.now();
      if (document.visibilityState !== 'hidden') visibleFor += (time - last) / 1000;
      last = time;
      const limit = this.limits[phase];
      if (!fired && limit !== undefined && visibleFor > limit) {
        fired = true;
        this.fatal('STUCK_PHASE', new Error(`The ${phase} phase did not finish in ${limit}s.`), {
          ...context,
          phase,
          seconds: Math.round(visibleFor),
        });
      }
    };
    const timer = setInterval(tick, interval);
    const stop = () => {
      clearInterval(timer);
      unsubscribe();
    };
    this.cleanups.push(stop);
    return stop;
  }

  /** Call whenever a case runtime is (re)built; too many in a short time is a loop. */
  noteRebuild(identity: string): void {
    const time = this.now(),
      recent = (this.rebuilds.get(identity) ?? []).filter((at) => time - at < REBUILD_WINDOW);
    recent.push(time);
    this.rebuilds.set(identity, recent);
    if (recent.length > REBUILD_LIMIT) {
      this.rebuilds.delete(identity);
      this.fatal(
        'RENDER_LOOP',
        new Error(
          `The case runtime was rebuilt ${recent.length} times in ${REBUILD_WINDOW / 1000}s.`,
        ),
        { identity },
      );
    }
  }

  /** Report and show the modal (once until it is dismissed). */
  fatal(code: string, error: unknown, context: Readonly<Record<string, unknown>> = {}): void {
    this.options.reporter.capture(error ?? new Error(code), { ...context, code });
    if (this.open) return;
    this.open = true;
    this.show(code, (error as { area?: unknown } | null)?.area);
  }

  get visible(): boolean {
    return this.open;
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.dialog?.remove();
    this.dialog = undefined;
    this.open = false;
  }

  private show(code: string, area?: unknown) {
    const document = this.options.document;
    if (!this.dialog) {
      ensureStyles(document);
      const dialog = document.createElement('dialog');
      dialog.className = 'failsafe';
      dialog.setAttribute('role', 'alertdialog');
      dialog.setAttribute('aria-labelledby', 'failsafe-title');
      dialog.setAttribute('aria-describedby', 'failsafe-text');
      // Same card as the React ErrorNotice (error-notice.css), so every error looks alike.
      dialog.innerHTML = `<div class="error-notice__panel">
        <button type="button" class="error-notice__close" data-action="close" aria-label="Закрыть и вернуться на главную">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
        </button>
        <span class="error-notice__mark" aria-hidden="true">!</span>
        <p class="error-notice__eyebrow">Что-то пошло не так</p>
        <h2 class="error-notice__title" id="failsafe-title">Сундук завис</h2>
        <div class="error-notice__text"><p id="failsafe-text">Мы уже знаем об ошибке. Ваши сундуки и награды на месте — можно вернуться на главную или перезагрузить страницу.</p></div>
        <div class="error-notice__actions"><button type="button" class="btn" data-action="home">В главное меню</button>
          <button type="button" class="btn" data-action="reload">Перезагрузить</button></div>
        <p class="failsafe__code"></p>
      </div>`;
      dialog.addEventListener('click', (event) => {
        const action = (event.target as Element | null)
          ?.closest?.('[data-action]')
          ?.getAttribute('data-action');
        if (action === 'home' || action === 'close') this.goHome();
        else if (action === 'reload')
          (this.options.reload ?? (() => document.defaultView?.location.reload()))();
      });
      // Escape means the same as "На главную": never back into the broken state.
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        this.goHome();
      });
      document.body.append(dialog);
      this.dialog = dialog;
    }
    const copy = typeof area === 'string' ? AREA_COPY[area] : undefined;
    // Reused dialog: every show sets its words, or an earlier area's copy would stick.
    this.dialog.querySelector('#failsafe-title')!.textContent = copy?.title ?? DEFAULT_COPY.title;
    this.dialog.querySelector('#failsafe-text')!.textContent = copy?.text ?? DEFAULT_COPY.text;
    const home = this.dialog.querySelector('[data-action="home"]') as HTMLButtonElement;
    home.hidden = this.options.isHome?.() === true;
    this.dialog.querySelector('.failsafe__code')!.textContent = `Код: ${code}`;
    try {
      this.dialog.showModal();
    } catch {
      this.dialog.setAttribute('open', '');
    }
    (
      this.dialog.querySelector(
        home.hidden ? '[data-action="reload"]' : '[data-action="home"]',
      ) as HTMLButtonElement | null
    )?.focus();
  }

  private goHome() {
    this.dialog?.close?.();
    this.dialog?.removeAttribute('open');
    this.open = false;
    try {
      this.options.goHome();
    } catch (error) {
      this.options.reporter.capture(error, { code: 'GO_HOME_FAILED' });
      this.options.document.defaultView?.location.assign('#/inventory');
    }
  }
}

function ensureStyles(document: Document) {
  if (document.getElementById('failsafe-styles')) return;
  const style = document.createElement('style');
  style.id = 'failsafe-styles';
  // Only the dialog frame and a fallback of the card: error-notice.css normally styles the card,
  // but this modal must still read correctly when the app's styles never loaded.
  style.textContent = `
    .failsafe { padding: 0; border: 0; background: transparent; max-width: min(440px, calc(100vw - 32px)); width: 100%; overflow: visible; }
    .failsafe::backdrop { background: #07050acc; backdrop-filter: blur(4px); }
    .failsafe .error-notice__panel { position: relative; box-sizing: border-box; width: 100%; display: grid; justify-items: center; gap: 10px; padding: 34px 28px 24px; border: 1px solid #e3665a33; border-radius: 6px;
      background: linear-gradient(145deg, #241817, #120d0d 72%); color: #e9dcd9; text-align: center; font: 15px/1.45 Manrope, system-ui, sans-serif; }
    .failsafe .error-notice__eyebrow { margin: 0; color: #e3665a; font-size: 11px; letter-spacing: .16em; text-transform: uppercase; }
    .failsafe .error-notice__title { margin: 0; color: #f4e9e6; font-size: 24px; }
    .failsafe p { margin: 0; }
    .failsafe .error-notice__actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 14px; }
    .failsafe .error-notice__actions .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 11px 18px; border: 1px solid transparent; border-radius: 2px;
      background: linear-gradient(180deg, #e6e8e6, #bcc0bd); color: #111412; font: 600 12px/1.2 system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; cursor: pointer; }
    .failsafe .error-notice__actions .btn[hidden] { display: none; }
    .failsafe .error-notice__close { position: absolute; top: 8px; right: 8px; display: grid; place-items: center; width: 44px; height: 44px; padding: 0;
      color: #ff9a8f; background: #e3665a14; border: 1px solid #e3665a33; border-radius: 6px; cursor: pointer; }
    .failsafe button:focus-visible { outline: 2px solid #ff9a8f; outline-offset: 3px; }
    .failsafe .error-notice__close:active { background: #e3665a33; }
    @media (hover: hover) and (pointer: fine) { .failsafe .error-notice__close:hover { background: #e3665a26; color: #fff5f2; border-color: #e3665a66; } }
    @media (max-width: 560px) { .failsafe .error-notice__panel { padding-inline: 18px; } .failsafe .error-notice__actions .btn { flex: 1 1 100%; } }
    .failsafe__code { margin-top: 8px !important; color: #7d625d; font-size: 11px; letter-spacing: .04em; }`;
  document.head.append(style);
}
