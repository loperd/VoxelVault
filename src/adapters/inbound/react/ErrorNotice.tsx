import type { ReactNode } from 'react';
import { MainMenuButton } from './MainMenuButton.tsx';

/**
 * Every error the player can see looks the same: a small card on the world surface with a
 * warning mark, what failed, what to do, and the way out. The failsafe modal (plain DOM, outside
 * React) builds the same markup with the same classes.
 */
export function ErrorNotice({
  eyebrow = 'Что-то пошло не так',
  title,
  children,
  actions,
  onClose,
  compact = false,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly onClose?: () => void;
  readonly compact?: boolean;
}) {
  return (
    <section className={`error-notice${compact ? ' error-notice--compact' : ''}`} role="alert">
      <div className="error-notice__panel">
        {onClose && (
          <button
            type="button"
            className="error-notice__close"
            aria-label="Закрыть"
            onClick={onClose}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M3 3l10 10M13 3L3 13"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
        <span className="error-notice__mark" aria-hidden="true">
          !
        </span>
        <p className="error-notice__eyebrow">{eyebrow}</p>
        <h2 className="error-notice__title">{title}</h2>
        {children && <div className="error-notice__text">{children}</div>}
        <div className="error-notice__actions">
          {actions}
          <MainMenuButton />
        </div>
      </div>
    </section>
  );
}
