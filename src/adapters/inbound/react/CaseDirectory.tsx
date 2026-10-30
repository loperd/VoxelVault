import { isConsumed, type CaseInstance } from '../../../domain/case-instance.ts';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { CaseDefinition } from '../../../config/cases.ts';
import type { Navigation } from '../../../application/ports/navigation.ts';
import type { ScreenStorage } from '../../outbound/browser/screen-storage.ts';
import type { ChestPreviewRenderer } from '../../outbound/chest/chest-preview-renderer.ts';
import { ChestThumbnail } from './ChestThumbnail.tsx';
import { ScreenHeader } from './ScreenHeader.tsx';
import type { SoundPreference } from './SoundControl.tsx';

export function CaseDirectory({
  cases,
  navigation,
  storage,
  renderer,
  soundPreference,
  instances = [],
}: {
  readonly soundPreference?: SoundPreference;
  readonly instances?: readonly CaseInstance[];
  readonly cases: readonly CaseDefinition[];
  readonly navigation: Navigation;
  readonly storage: ScreenStorage;
  readonly renderer: Pick<ChestPreviewRenderer, 'render'>;
}) {
  const saved = useRef(
    storage.read('screen:catalog', (value) => {
      if (!value || typeof value !== 'object') return { collection: 'all', scroll: 0 };
      const v = value as Record<string, unknown>;
      return {
        collection: typeof v.collection === 'string' ? v.collection : 'all',
        scroll:
          typeof v.scroll === 'number' && v.scroll >= 0 && v.scroll < 1_000_000 ? v.scroll : 0,
      };
    }),
  );
  const [collection, setCollection] = useState(() => {
    const selected = saved.current?.collection;
    return selected && cases.some((item) => item.collectionId === selected) ? selected : 'all';
  });
  const page = useRef<HTMLElement>(null);
  useEffect(() => {
    if (page.current) page.current.scrollTop = saved.current?.scroll ?? 0;
  }, []);
  useEffect(() => {
    const element = page.current!;
    const save = () => storage.write('screen:catalog', { collection, scroll: element.scrollTop });
    save();
    element.addEventListener('scroll', save, { passive: true });
    return () => {
      save();
      element.removeEventListener('scroll', save);
    };
  }, [collection, storage]);
  const collections = [
    ...new Map(cases.map((item) => [item.collectionId, item.presentation.collection])).entries(),
  ];
  const visible = cases.filter((item) => collection === 'all' || item.collectionId === collection);
  return (
    <main ref={page} className="page-shell case-directory">
      <div className="case-directory__content page-container">
        <ScreenHeader
          navigation={navigation}
          active="catalog"
          archiveCount={instances.filter(isConsumed).length}
          soundPreference={soundPreference}
        />
        <section className="case-directory__intro">
          <p className="eyebrow">Твоя следующая история</p>
          <h1>
            За каждой крышкой —<br />
            новое приключение.
          </h1>
          <p>Выбери сундук, изучи его сокровища и узнай, какая находка ждёт тебя.</p>
        </section>
        <div className="case-directory__filters">
          <nav aria-label="Коллекции сундуков">
            <button
              type="button"
              aria-pressed={collection === 'all'}
              onClick={() => setCollection('all')}
            >
              Все сундуки <span>{cases.length}</span>
            </button>
            {collections.map(([id, title]) => (
              <button
                key={id}
                type="button"
                aria-pressed={collection === id}
                onClick={() => setCollection(id)}
              >
                {title}
              </button>
            ))}
          </nav>
        </div>
        <div className="case-directory__grid">
          {visible.map((item) => (
            <button
              type="button"
              className="case-card"
              key={item.id}
              style={
                {
                  '--case-accent': item.presentation.theme.accent,
                  '--case-accent-highlight': item.presentation.theme.highlight,
                  '--case-accent-deep': item.presentation.theme.deep,
                  '--case-accent-glow': item.presentation.theme.glow,
                } as CSSProperties
              }
              onClick={() =>
                navigation.go({ screen: 'case', caseId: item.id, returnTo: 'catalog' })
              }
            >
              <div className="case-card__art">
                <span aria-hidden="true">◇</span>
                <ChestThumbnail
                  renderer={renderer}
                  definition={item}
                  appearance={item.appearance}
                />
              </div>
              <div className="case-card__info">
                <p className="eyebrow">{item.presentation.collection}</p>
                <h2>{item.presentation.title}</h2>
                <p>{item.presentation.description}</p>
                <p className="case-card__owned">
                  Готово к открытию:{' '}
                  <strong>
                    {
                      instances.filter(
                        (instance) =>
                          instance.caseId === item.id && instance.status === 'available',
                      ).length
                    }{' '}
                    шт.
                  </strong>
                </p>
                <span className="case-card__action">
                  Посмотреть содержимое <span aria-hidden="true">↗</span>
                </span>
              </div>
            </button>
          ))}
        </div>
        {visible.length === 0 && (
          <p className="case-directory__empty" role="status">
            Таких сундуков пока нет. Попробуй другое название или коллекцию.
          </p>
        )}
      </div>
    </main>
  );
}
