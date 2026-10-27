import type { CSSProperties, Ref } from 'react';
import type { ItemState } from '../../../domain/case-instance.ts';
import type { Item } from '../../../domain/item.ts';
import { CASE_RARITY_PALETTES } from '../../../config/cases.ts';
import { ITEM_STATE_LABELS } from '../../../config/resources.ts';
import { Button } from './Button.tsx';
import { ItemArt } from './ItemArt.tsx';
import { useCasePresentation } from './case-presentation.ts';

const RARITY_LABELS = {
  common: 'Обычный предмет',
  uncommon: 'Необычный предмет',
  rare: 'Редкий предмет',
  epic: 'Эпический предмет',
  legendary: 'Легендарный предмет',
} as const;

/** The reward, in the same rarity palette as its roulette card; a damaged drop says so. */
export function PrizeScene({
  prize,
  condition = 'intact',
  actionRef,
  onClose,
  availableCaseCount,
  returnLabel = 'Вернуться к сундуку',
}: {
  readonly availableCaseCount?: number;
  readonly returnLabel?: string;
  readonly prize: Item;
  readonly condition?: ItemState;
  readonly actionRef: Ref<HTMLButtonElement>;
  readonly onClose: () => void;
}) {
  const casePresentation = useCasePresentation();
  const palette = CASE_RARITY_PALETTES[prize.rarity],
    damaged = condition !== 'intact';
  return (
    <section
      className={`prize prize--${prize.rarity}${damaged ? ` prize--damaged prize--${condition}` : ''}`}
      aria-labelledby="prize-title"
      style={
        {
          '--prize-color': palette.highlight,
          '--prize-primary': palette.primary,
          '--prize-deep': palette.deep,
        } as CSSProperties
      }
    >
      <header className="prize__header">
        <p className="eyebrow">{casePresentation.collection}</p>
        <p className="prize__headline">
          {damaged ? 'Награда пострадала при открытии' : 'Сундук раскрыл свой секрет'}
        </p>
      </header>
      <div className="prize__art">
        <div className="prize__rays" aria-hidden="true" />
        <div className="prize__aura" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        <ItemArt item={prize} size={280} live condition={condition} />
      </div>
      <div className="prize__details">
        <span className="prize__rarity">
          <span aria-hidden="true">◆</span> {RARITY_LABELS[prize.rarity]}
        </span>
        <p className="prize__label">Ваша награда</p>
        <h2 id="prize-title">{prize.title}</h2>
        {damaged && <p className="prize__condition">Состояние: {ITEM_STATE_LABELS[condition]}</p>}
        <p className="prize__source">Из сундука «{casePresentation.title}»</p>
      </div>
      <footer className="prize__actions">
        <Button ref={actionRef} variant="transparent" onClick={onClose}>
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
