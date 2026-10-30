import { useCallback } from 'react';
import type { ChestPreview } from '../../../application/ports/chest-preview.ts';
import { useObservableState } from './use-observable-state.ts';
import { Button } from './Button.tsx';
import { ErrorNotice } from './ErrorNotice.tsx';

export function ChestPreviewPanel({
  preview,
  element,
}: {
  readonly preview: ChestPreview;
  readonly element?: HTMLElement;
}) {
  const state = useObservableState(preview);
  const mount = useCallback(
    (host: HTMLDivElement | null) => {
      if (!host || !element) return;
      host.appendChild(element);
      return () => {
        if (element.parentNode === host) element.remove();
      };
    },
    [element],
  );
  if (state.phase === 'disposed') return null;
  return (
    <section className="chest-preview" aria-label="Сундук">
      <div className="chest-preview__viewport" ref={mount} />
      {(state.phase === 'idle' || state.phase === 'loading' || state.phase === 'resetting') && (
        <div className="chest-preview__status" role="status" aria-live="polite">
          <span className="loader" aria-hidden="true" />
          <p>Готовим сундук…</p>
        </div>
      )}
      {state.phase === 'failed' && (
        <ErrorNotice
          compact
          title="Не удалось загрузить сундук"
          actions={
            <Button
              onClick={() => {
                void preview.retry();
              }}
            >
              Повторить
            </Button>
          }
        />
      )}
      {state.phase === 'ready' && (
        <div className="chest-preview__actions">
          <Button
            variant="secondary"
            onClick={() => {
              void preview.replay();
            }}
          >
            Ещё раз
          </Button>
        </div>
      )}
    </section>
  );
}
