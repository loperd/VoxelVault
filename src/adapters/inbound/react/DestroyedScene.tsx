import { useState, type CSSProperties, type Ref } from 'react';
import { Button } from './Button.tsx';
import { useCasePresentation } from './case-presentation.ts';

/** Error colour of the outcome screens (the reward screen uses the rarity colour instead). */
const DESTROYED_COLOR = '#e3665a';

/**
 * The destruction outcome: the same screen as the reward (PrizeScene), in the error palette.
 * Where the reward shows the item, this shows this very chest in pieces; the reward is lost.
 */
export function DestroyedScene({
  actionRef,
  onClose,
  availableCaseCount,
  returnLabel = 'Вернуться к сундуку',
  captureWreck,
}: {
  readonly availableCaseCount?: number;
  readonly returnLabel?: string;
  readonly actionRef: Ref<HTMLButtonElement>;
  readonly onClose: () => void;
  /** A picture of this chest as it broke: its own fragments, texture and modifications. */
  readonly captureWreck?: () => string | undefined;
}) {
  const casePresentation = useCasePresentation();
  const [wreck] = useState(() => captureWreck?.());
  return (
    <section
      className="prize prize--destroyed"
      aria-labelledby="prize-title"
      role="alert"
      style={{ '--prize-color': DESTROYED_COLOR } as CSSProperties}
    >
      <header className="prize__header">
        <p className="eyebrow">{casePresentation.collection}</p>
        <p className="prize__headline">Сундук не выдержал мощности энергии</p>
      </header>
      <div className="prize__art">
        <div className="prize__aura" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        {wreck && <img className="prize__wreck" src={wreck} alt="Разрушенный сундук" />}
      </div>
      <div className="prize__details">
        <span className="prize__rarity">
          <span aria-hidden="true">◆</span> Сундук разрушен
        </span>
        <p className="prize__label">Итог открытия</p>
        <h2 id="prize-title">Награда не получена</h2>
        <p className="prize__source">
          Сундук «{casePresentation.title}» разлетелся вместе с тем, что было внутри
        </p>
      </div>
      <footer className="prize__actions">
        <Button ref={actionRef} variant="secondary" onClick={onClose}>
          Закрыть
        </Button>
        <p>{returnLabel}</p>
        {availableCaseCount !== undefined && (
          <p className="prize__remaining">Готово к открытию: {availableCaseCount} шт.</p>
        )}
      </footer>
    </section>
  );
}
