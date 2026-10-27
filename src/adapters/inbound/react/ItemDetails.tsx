import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Item } from '../../../domain/item.ts';
import { Button } from './Button.tsx';
import { ItemArt } from './ItemArt.tsx';
import { storyFor } from './item-stories.ts';
import { useCasePresentation } from './case-presentation.ts';

export const rarityLabels = {
  common: 'Обычный',
  uncommon: 'Необычный',
  rare: 'Редкий',
  epic: 'Эпический',
  legendary: 'Легендарный',
} as const;

/** Native modal supplies focus containment, Escape handling and an inert background. */
export function ItemDetails({
  item,
  onClose,
  browse,
}: {
  readonly item: Item;
  readonly onClose: () => void;
  readonly browse?: { index: number; total: number; previous(): void; next(): void };
}) {
  const casePresentation = useCasePresentation();
  const story = storyFor(item);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const trigger = element.ownerDocument.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className={`item-details item-details--${item.rarity}`}
      aria-labelledby="item-details-title"
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' && browse) {
          event.preventDefault();
          browse.previous();
        }
        if (event.key === 'ArrowRight' && browse) {
          event.preventDefault();
          browse.next();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="item-details__panel">
        <div className="item-details__portrait">
          <p className="eyebrow">{casePresentation.collection}</p>
          <div className="item-details__art">
            <span className="item-details__sigil" aria-hidden="true">
              ◇
            </span>
            <ItemArt key={item.id} item={item} size={320} live />
          </div>
          <span className="item-details__rarity">
            <span aria-hidden="true">◆</span> {rarityLabels[item.rarity]}
          </span>
          <p className="item-details__symbol">{story.symbol}</p>
        </div>
        <div className="item-details__narrative">
          <p className="eyebrow">Истории Края</p>
          <h2 id="item-details-title">{item.title}</h2>
          <p className="item-details__epithet">{story.epithet}</p>
          <div className="item-details__origin">
            <span>Происхождение</span>
            <strong>{story.origin}</strong>
          </div>
          <p className="item-details__story">{story.story}</p>
          <blockquote className="item-details__quote">
            <p>«{story.quote}»</p>
            <cite>{story.signature}</cite>
          </blockquote>
          <p className="item-details__source">Из сундука «{casePresentation.title}»</p>
        </div>
        <footer className="item-details__footer">
          {browse && (
            <nav className="item-details__browse" aria-label="Просмотр коллекции">
              <button type="button" aria-label="Предыдущий предмет" onClick={browse.previous}>
                ←
              </button>
              <span aria-live="polite">
                {String(browse.index + 1).padStart(2, '0')} <span>/ {browse.total}</span>
              </span>
              <button type="button" aria-label="Следующий предмет" onClick={browse.next}>
                →
              </button>
            </nav>
          )}
          <Button variant="transparent" onClick={onClose}>
            Закрыть просмотр
          </Button>
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}
