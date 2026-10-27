import { ChestIndicators } from './ChestIndicators.tsx';
import { isConsumed } from '../../../domain/case-instance.ts';
import { partConditions } from '../../../domain/chest-appearance.ts';
import { RARITIES } from '../../../domain/item.ts';
import { damageLevel, groupInventory } from '../../../application/inventory-groups.ts';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { CASE_RARITY_LABELS, type CaseDefinition, type CaseRarity } from '../../../config/cases.ts';
import type { Navigation } from '../../../application/ports/navigation.ts';
import type { PlayerInventory } from '../../../application/ports/player-inventory.ts';
import type { ItemsState, PlayerItems } from '../../../application/ports/player-items.ts';
import type { ScreenStorage } from '../../outbound/browser/screen-storage.ts';
import type { ChestPreviewRenderer } from '../../outbound/chest/chest-preview-renderer.ts';
import { useObservableState } from './use-observable-state.ts';
import { ChestThumbnail } from './ChestThumbnail.tsx';
import { ScreenHeader } from './ScreenHeader.tsx';
import { InventoryTabs } from './InventoryTabs.tsx';
import { ChestMerge } from './ChestMerge.tsx';
import type { CaseInstance } from '../../../domain/case-instance.ts';
import type { SoundPreference } from './SoundControl.tsx';

const EMPTY_ITEMS: ItemsState = Object.freeze({ loaded: false, items: Object.freeze([]) });
const NO_ITEMS = { getState: () => EMPTY_ITEMS, subscribe: () => () => {} };

export function InventoryScreen({
  inventory,
  items,
  cases,
  navigation,
  storage,
  renderer,
  soundPreference,
  mode = 'inventory',
}: {
  readonly soundPreference?: SoundPreference;
  readonly mode?: 'inventory' | 'archive';
  readonly inventory: PlayerInventory;
  readonly cases: readonly CaseDefinition[];
  readonly navigation: Navigation;
  readonly items?: PlayerItems;
  readonly storage: ScreenStorage;
  readonly renderer: Pick<ChestPreviewRenderer, 'render'>;
}) {
  const instances = useObservableState(inventory);
  const owned = useObservableState(items ?? NO_ITEMS);
  const saved = useRef(
    storage.read(mode === 'archive' ? 'screen:archive' : 'screen:inventory', (value) => {
      const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      return {
        rarity:
          typeof v.rarity === 'string' &&
          ['common', 'uncommon', 'rare', 'epic', 'legendary'].includes(v.rarity)
            ? v.rarity
            : 'all',
        density: v.density === 'compact' ? 'compact' : 'comfortable',
        filter: ['all', 'available', 'opened'].includes(String(v.filter))
          ? String(v.filter)
          : 'all',
        scroll:
          typeof v.scroll === 'number' && v.scroll >= 0 && v.scroll < 1_000_000 ? v.scroll : 0,
      };
    }),
  );
  const [rarity, setRarity] = useState<string>(saved.current?.rarity ?? 'all');
  const [density, setDensity] = useState(saved.current?.density ?? 'comfortable');
  const [merging, setMerging] = useState<{
    readonly definition: CaseDefinition;
    readonly initial: string;
  }>();
  const [merged, setMerged] = useState<CaseInstance>();
  const page = useRef<HTMLElement>(null);
  useEffect(() => {
    if (page.current) page.current.scrollTop = saved.current?.scroll ?? 0;
  }, []);
  useEffect(() => {
    const element = page.current!;
    const save = () =>
      storage.write(mode === 'archive' ? 'screen:archive' : 'screen:inventory', {
        rarity,
        density,
        scroll: element.scrollTop,
      });
    save();
    element.addEventListener('scroll', save, { passive: true });
    return () => {
      save();
      element.removeEventListener('scroll', save);
    };
  }, [storage, rarity, density, mode]);
  const available = instances.filter((item) => item.status === 'available');
  const screenInstances = instances.filter((item) =>
    mode === 'archive' ? isConsumed(item) : !isConsumed(item),
  );
  // A chest's class is its own rarity, frozen by the server from what it holds, not its type's.
  const visible = screenInstances.filter(
    (item) => !rarity || rarity === 'all' || item.rarity === rarity,
  );
  const groups =
    mode === 'archive'
      ? visible.map((instance) => ({
          key: instance.id,
          instances: [instance],
          representative: instance,
        }))
      : groupInventory(visible);
  const rarities = RARITIES as readonly CaseRarity[];
  return (
    <main className={`page-shell inventory inventory--${density} inventory--${mode}`} ref={page}>
      <div className="inventory__content page-container">
        <ScreenHeader
          navigation={navigation}
          active={mode}
          archiveCount={instances.filter(isConsumed).length}
          soundPreference={soundPreference}
        />
        <div className="inventory__intro">
          <div>
            <p className="eyebrow">
              {mode === 'archive' ? 'Открытия и награды' : 'Твои находки. Твои истории.'}
            </p>
            <h1>
              {mode === 'archive' ? 'Архив' : 'Инвентарь'}{' '}
              <span>{mode === 'archive' ? screenInstances.length : available.length}</span>
            </h1>
            <p>
              {mode === 'archive'
                ? 'Открытые сундуки и найденные в них предметы.'
                : 'Сундуки собраны по типу, окраске, повреждениям и состоянию.'}
            </p>
          </div>
        </div>
        {mode === 'inventory' && (
          <InventoryTabs
            navigation={navigation}
            active="chests"
            chests={available.length}
            items={owned?.loaded ? owned.items.length : undefined}
          />
        )}
        <nav className="inventory__rarities" aria-label="Редкость сундука">
          <button type="button" aria-pressed={rarity === 'all'} onClick={() => setRarity('all')}>
            Все классы
          </button>
          {rarities.map((value) => (
            <button
              type="button"
              key={value}
              className={`case-rarity case-rarity--${value}`}
              aria-pressed={rarity === value}
              onClick={() => setRarity(value)}
            >
              {CASE_RARITY_LABELS[value]}
              <span>{screenInstances.filter((instance) => instance.rarity === value).length}</span>
            </button>
          ))}
        </nav>
        <div className="inventory__toolbar">
          <div className="inventory__tools">
            <button
              type="button"
              className="inventory__density"
              aria-pressed={density === 'compact'}
              onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
            >
              {density === 'compact' ? 'Крупные карточки' : 'Компактный вид'}
            </button>
          </div>
        </div>
        {merged && (
          <p className="inventory__notice" role="status">
            Новый сундук готов.
            <button
              type="button"
              onClick={() =>
                navigation.go({ screen: 'case', caseId: merged.caseId, instanceId: merged.id })
              }
            >
              Осмотреть
            </button>
          </p>
        )}
        <section className="inventory__grid" aria-label="Мои сундуки">
          {groups.map((group) => {
            const instance = group.representative;
            const definition = cases.find((value) => value.id === instance.caseId);
            if (!definition) return null;
            const profile = definition.model.modifications;
            const mergeable =
              mode === 'inventory' &&
              instance.status === 'available' &&
              available.filter((item) => item.caseId === instance.caseId).length >= 2;
            const condition = damageLevel(
              Math.max(
                0,
                ...partConditions(instance.appearance, profile).map((item) => item.value),
              ),
            );

            return (
              <article
                className={`inventory-card inventory-card--${instance.status}`}
                key={group.key}
                style={
                  {
                    '--chest-color': instance.appearance.palette.panel,
                    '--chest-accent': instance.appearance.palette.accent,
                    '--case-accent': definition.presentation.theme.accent,
                    '--case-accent-highlight': definition.presentation.theme.highlight,
                    '--case-accent-deep': definition.presentation.theme.deep,
                    '--case-accent-glow': definition.presentation.theme.glow,
                  } as CSSProperties
                }
              >
                <div className="inventory-card__top">
                  <span>
                    <i className={`case-rarity-mark case-rarity-mark--${definition.rarity}`} />
                    {definition.presentation.collection}{' '}
                    <small className={`case-rarity-label case-rarity-label--${definition.rarity}`}>
                      {CASE_RARITY_LABELS[definition.rarity]}
                    </small>
                  </span>
                  <span className="inventory-card__quantity">
                    {group.instances.length} <small>шт.</small>
                  </span>
                </div>
                <button
                  type="button"
                  className="inventory-card__inspect"
                  aria-label={`Осмотреть ${definition.presentation.title}, ${condition.label}, ${group.instances.length} шт.`}
                  onClick={() =>
                    navigation.go({
                      screen: 'case',
                      caseId: instance.caseId,
                      instanceId: instance.id,
                      ...(mode === 'archive' ? { returnTo: 'archive' as const } : {}),
                    })
                  }
                >
                  <ChestThumbnail
                    renderer={renderer}
                    definition={definition}
                    appearance={instance.appearance}
                  />
                </button>
                <div className="inventory-card__info">
                  <h2>{definition.presentation.title}</h2>
                  <ChestIndicators
                    appearance={instance.appearance}
                    profile={profile}
                    grouped
                    status={instance.status}
                    showParts={false}
                  />
                  <div className="inventory-card__footer">
                    <span>
                      {instance.status === 'opening'
                        ? 'Открывается'
                        : instance.status === 'opened'
                          ? 'Открыт'
                          : instance.status === 'destroyed'
                            ? 'Разрушен'
                            : 'Готов к открытию'}
                    </span>
                    <span aria-hidden="true">↗</span>
                  </div>
                  {mergeable && (
                    <button
                      type="button"
                      className="inventory-card__merge"
                      onClick={() => {
                        setMerged(undefined);
                        setMerging({ definition, initial: instance.id });
                      }}
                    >
                      Объединить
                    </button>
                  )}
                  {instance.reward && (
                    <p className="inventory-card__reward">
                      {group.instances.length === 1
                        ? `Найдено: ${instance.reward.title}`
                        : `Наград получено: ${group.instances.length}`}
                    </p>
                  )}
                  {mode === 'archive' &&
                    (instance.openedAt ? (
                      <time className="inventory-card__opened-at" dateTime={instance.openedAt}>
                        {new Intl.DateTimeFormat('ru-RU', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }).format(new Date(instance.openedAt))}
                      </time>
                    ) : (
                      <p className="inventory-card__opened-at">Дата открытия не сохранена</p>
                    ))}
                </div>
              </article>
            );
          })}
        </section>
        {visible.length === 0 && (
          <div className="inventory__empty">
            <span aria-hidden="true">◇</span>
            <h2>
              {mode === 'archive'
                ? 'Архив пока пуст'
                : rarity !== 'all'
                  ? `В классе ${CASE_RARITY_LABELS[rarity as CaseRarity]} пока пусто`
                  : 'Здесь начнётся твоя коллекция'}
            </h2>
            <p>
              {mode === 'archive'
                ? 'Открытые сундуки и награды будут храниться здесь.'
                : 'Кейсы, которые ты найдёшь или приобретёшь, появятся здесь.'}
            </p>
          </div>
        )}
        {merging && (
          <ChestMerge
            inventory={inventory}
            definition={merging.definition}
            initial={merging.initial}
            onClose={() => setMerging(undefined)}
            onMerged={(chest) => {
              setMerging(undefined);
              setMerged(chest);
            }}
          />
        )}
      </div>
    </main>
  );
}
