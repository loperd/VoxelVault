import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { CaseInstance } from '../../../domain/case-instance.ts';
import { partConditions, resolveModifications } from '../../../domain/chest-appearance.ts';
import { integrityPercent } from '../../../application/inventory-groups.ts';
import type { CaseDefinition } from '../../../config/cases.ts';
import type { MergeOdds, PlayerInventory } from '../../../application/ports/player-inventory.ts';
import { Button } from './Button.tsx';

type Odds = { readonly pair: string; readonly odds?: MergeOdds; readonly failed?: boolean };

/**
 * Two available chests of one type become one new chest. The player picks the pair; the server
 * says the chances for it (what each trait does, how many items stay) before anything is spent,
 * and the server alone rolls them. Native modal: focus containment, Escape and inert background.
 */
export function ChestMerge({
  inventory,
  definition,
  initial,
  onClose,
  onMerged,
}: {
  readonly inventory: Pick<PlayerInventory, 'getState' | 'mergeOdds' | 'merge'>;
  readonly definition: CaseDefinition;
  readonly initial: string;
  readonly onClose: () => void;
  readonly onMerged: (chest: CaseInstance) => void;
}) {
  const profile = definition.model.modifications;
  const label = (id: string) => profile.catalog.find((item) => item.id === id)?.label ?? id;
  const chests = inventory
    .getState()
    .filter((item) => item.caseId === definition.id && item.status === 'available');
  const [picked, setPicked] = useState<readonly string[]>(() =>
    [initial, chests.find((item) => item.id !== initial)?.id].filter((id): id is string => !!id),
  );
  const pair = picked.filter((id) => chests.some((item) => item.id === id));
  const key = pair.length === 2 ? pair.join(' ') : '';
  const [odds, setOdds] = useState<Odds>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
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
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController(),
      [a, b] = key.split(' ') as [string, string];
    inventory.mergeOdds(a, b, controller.signal).then(
      (value) => setOdds({ pair: key, odds: value }),
      () => {
        if (!controller.signal.aborted) setOdds({ pair: key, failed: true });
      },
    );
    return () => controller.abort();
  }, [inventory, key]);

  // A third pick replaces the first: the pair is always the last two chosen.
  const toggle = (id: string) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id].slice(-2),
    );
  const merge = async () => {
    const [a, b] = pair as [string, string];
    setBusy(true);
    setFailed(false);
    try {
      onMerged(await inventory.merge(a, b));
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  const shown = odds?.pair === key ? odds : undefined;

  return createPortal(
    <dialog
      ref={dialog}
      className="chest-merge"
      aria-labelledby="chest-merge-title"
      aria-busy={busy || undefined}
      style={{ '--case-accent': definition.presentation.theme.accent } as CSSProperties}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <header className="chest-merge__header">
        <p className="eyebrow">{definition.presentation.collection}</p>
        <h2 id="chest-merge-title">Объединить: {definition.presentation.title}</h2>
        <p>
          Два сундука станут одним новым — оба исчезнут. Повреждения не переходят, особенности могут
          остаться и усилиться, из предметов останется часть.
        </p>
      </header>
      <fieldset className="chest-merge__pick" disabled={busy}>
        <legend>
          Выбери два сундука <span>{pair.length} из 2</span>
        </legend>
        <ul>
          {chests.map((chest, index) => {
            const integrity = integrityPercent(
              Math.max(0, ...partConditions(chest.appearance, profile).map((item) => item.value)),
            );
            const features = resolveModifications(chest.appearance, profile).map(
              (item) => item.definition.label,
            );
            return (
              <li key={chest.id}>
                <button
                  type="button"
                  aria-pressed={pair.includes(chest.id)}
                  onClick={() => toggle(chest.id)}
                  style={
                    {
                      '--chest-color': chest.appearance.palette.panel,
                      '--chest-accent': chest.appearance.palette.accent,
                    } as CSSProperties
                  }
                >
                  <i className="chest-merge__swatch" aria-hidden="true" />
                  <span className="chest-merge__name">
                    Сундук {index + 1}
                    {chest.id === initial ? <small> · выбранный</small> : null}
                  </span>
                  <span className="chest-merge__integrity">{integrity}%</span>
                  <span className="chest-merge__features">
                    {features.length ? features.join(', ') : 'Без особенностей'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <section className="chest-merge__odds" aria-label="Шансы объединения" aria-live="polite">
        {!key ? (
          <p className="chest-merge__hint">
            Выбери ещё {2 - pair.length === 2 ? 'два сундука' : 'один сундук'}.
          </p>
        ) : shown?.failed ? (
          <p className="chest-merge__error">Шансы недоступны: сервер не ответил.</p>
        ) : !shown?.odds ? (
          <p className="chest-merge__hint">Сервер считает шансы…</p>
        ) : (
          <>
            <h3>Особенности</h3>
            {shown.odds.traits.length === 0 ? (
              <p className="chest-merge__hint">У этих сундуков нет особенностей.</p>
            ) : (
              <ul className="chest-merge__traits">
                {shown.odds.traits.map((trait) => (
                  <li key={trait.id} data-kept={trait.keep > 0}>
                    <span>{label(trait.id)}</span>
                    <strong>
                      {trait.keep === 0
                        ? 'исчезнет'
                        : `останется ${trait.keep}%${trait.upgrade > 0 ? ` · усилится ${trait.upgrade}%` : ''}`}
                    </strong>
                  </li>
                ))}
              </ul>
            )}
            <h3>Предметы</h3>
            <p className="chest-merge__contents">
              Из <strong>{shown.odds.contents.total}</strong> разных предметов в новом сундуке
              останутся <strong>{shown.odds.contents.kept}</strong> — каждый с шансом{' '}
              {shown.odds.contents.keep}%.
            </p>
            <p className="chest-merge__hint">
              Редкость и состояние нового сундука оценятся заново.
            </p>
          </>
        )}
      </section>
      {failed && (
        <p className="chest-merge__error" role="alert">
          Сервер не принял объединение. Список обновлён — выбери пару ещё раз.
        </p>
      )}
      <footer className="chest-merge__footer">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Отмена
        </Button>
        <Button disabled={busy || !shown?.odds} onClick={() => void merge()}>
          {busy ? 'Объединяем…' : 'Объединить'}
        </Button>
      </footer>
    </dialog>,
    document.body,
  );
}
