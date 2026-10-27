import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CaseDefinition } from '../../../config/cases.ts';
import type { Navigation, ScreenRoute } from '../../../application/ports/navigation.ts';
import type { PlayerInventory } from '../../../application/ports/player-inventory.ts';
import { decodeCatalog } from '../../outbound/data/item-dto.ts';
import { resolvePublicAsset } from '../../outbound/data/asset-url.ts';
import { useObservableState } from './use-observable-state.ts';
import { BrandMark } from './BrandMark.tsx';

interface SearchResult {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly route: ScreenRoute;
  readonly kind: string;
}

export function GlobalSearch({
  navigation,
  cases,
  inventory,
  baseUrl,
}: {
  readonly navigation: Navigation;
  readonly cases: readonly CaseDefinition[];
  readonly inventory: PlayerInventory;
  readonly baseUrl: URL;
}) {
  const instances = useObservableState(inventory);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [catalogs, setCatalogs] = useState<
    readonly { definition: CaseDefinition; title: string; id: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cursor = useRef(0);

  useEffect(() => {
    const show = () => {
      setQuery('');
      setOpen(true);
    };
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && ['k', 'f'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        show();
      }
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('voxel:open-search', show);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('voxel:open-search', show);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const element = dialog.current!;
    const previous = element.ownerDocument.activeElement;
    element.showModal();
    input.current?.focus();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    void Promise.allSettled(
      cases.map(async (definition) => {
        const response = await fetch(resolvePublicAsset(definition.catalogPath, baseUrl));
        if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
        const items = decodeCatalog(await response.json(), baseUrl);
        return items.map((item) => ({ definition, id: item.id, title: item.title }));
      }),
    ).then((results) => {
      if (!current) return;
      setCatalogs(results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])));
      setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [open, cases, baseUrl]);

  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = (text: string) => !needle || text.toLocaleLowerCase().includes(needle);
    const result: SearchResult[] = [];
    for (const definition of cases) {
      const available = instances.filter(
        (instance) => instance.caseId === definition.id && instance.status === 'available',
      );
      if (
        matches(
          `${definition.presentation.title} ${definition.presentation.collection} ${definition.presentation.description}`,
        )
      ) {
        result.push({
          key: `case:${definition.id}`,
          title: definition.presentation.title,
          detail: `${definition.presentation.collection} · ${available.length} сундуков доступно`,
          kind: 'Кейс',
          route: { screen: 'case', caseId: definition.id },
        });
      }
      if (
        available.length &&
        matches(`${definition.presentation.title} ${definition.presentation.collection} инвентарь`)
      ) {
        result.push({
          key: `owned:${definition.id}`,
          title: definition.presentation.title,
          detail: `Инвентарь · ${available.length} можно открыть`,
          kind: 'Инвентарь',
          route: { screen: 'case', caseId: definition.id },
        });
      }
    }
    for (const instance of instances) {
      const definition = cases.find((value) => value.id === instance.caseId);
      if (!definition || !instance.reward || instance.status !== 'opened') continue;
      if (
        matches(
          `${instance.reward.title} ${definition.presentation.title} ${definition.presentation.collection} награда`,
        )
      ) {
        result.push({
          key: `reward:${instance.id}`,
          title: instance.reward.title,
          detail: `Награда · ${definition.presentation.title}`,
          kind: 'Архив',
          route: {
            screen: 'item',
            caseId: instance.caseId,
            instanceId: instance.id,
            itemId: instance.reward.id,
            returnTo: 'archive',
          },
        });
      }
    }
    for (const item of catalogs) {
      const definition = item.definition;
      if (
        matches(
          `${item.title} ${definition.presentation.title} ${definition.presentation.collection}`,
        )
      ) {
        result.push({
          key: `item:${definition.id}:${item.id}`,
          title: item.title,
          detail: `Предмет · ${definition.presentation.title}`,
          kind: 'Содержимое',
          route: { screen: 'item', caseId: definition.id, itemId: item.id },
        });
      }
    }
    return result.slice(0, 12);
  }, [query, cases, instances, catalogs]);

  useEffect(() => {
    cursor.current = 0;
  }, [query]);
  if (!open) return null;
  const choose = (route: ScreenRoute) => {
    setOpen(false);
    navigation.go(route);
  };
  const items = results.length > 0 ? results : [];
  return createPortal(
    <dialog
      ref={dialog}
      className="global-search"
      aria-label="Поиск по сайту"
      onCancel={(event) => {
        event.preventDefault();
        setOpen(false);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' && items.length) {
          event.preventDefault();
          cursor.current = (cursor.current + 1) % items.length;
          dialog.current
            ?.querySelectorAll<HTMLButtonElement>('.global-search__result')
            [cursor.current]?.focus();
        }
        if (event.key === 'ArrowUp' && items.length) {
          event.preventDefault();
          cursor.current = (cursor.current - 1 + items.length) % items.length;
          dialog.current
            ?.querySelectorAll<HTMLButtonElement>('.global-search__result')
            [cursor.current]?.focus();
        }
        if (event.key === 'Enter' && items.length) {
          const active =
            document.activeElement?.closest<HTMLButtonElement>('.global-search__result');
          choose(
            items[
              active
                ? [...dialog.current!.querySelectorAll('.global-search__result')].indexOf(active)
                : cursor.current
            ]!.route,
          );
        }
      }}
    >
      <div className="global-search__panel">
        <div className="global-search__input">
          <span aria-hidden="true">⌕</span>
          <input
            ref={input}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск по кейсам, предметам и наградам"
            aria-label="Поиск по всему сайту"
          />
          <kbd>ESC</kbd>
        </div>
        <div className="global-search__results" aria-live="polite">
          {results.map((result, index) => (
            <button
              className="global-search__result"
              key={result.key}
              type="button"
              onMouseEnter={() => {
                cursor.current = index;
              }}
              onClick={() => choose(result.route)}
            >
              <span className="global-search__result-icon">
                <BrandMark />
              </span>
              <span className="global-search__result-copy">
                <strong>{result.title}</strong>
                <small>{result.detail}</small>
              </span>
              <span className="global-search__result-kind">{result.kind}</span>
              <span className="global-search__enter" aria-hidden="true">
                ↵
              </span>
            </button>
          ))}
          {results.length === 0 && (
            <p className="global-search__empty">
              {loading
                ? 'Загружаем каталог…'
                : query
                  ? 'Ничего не найдено'
                  : 'Начни вводить название кейса, предмета или награды'}
            </p>
          )}
        </div>
        <footer className="global-search__footer">
          <span>↑↓ навигация</span>
          <span>↵ открыть</span>
          <span>
            <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> поиск
          </span>
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}
