import { useEffect, useRef, useState } from 'react';
import { useScreenNavigation } from './NavigationContext.tsx';
import { ItemDetails, rarityLabels } from './ItemDetails.tsx';
import { ItemArt } from './ItemArt.tsx';
import type { Item } from '../../../domain/item.ts';

export function Catalog({ items }: { readonly items: readonly Item[] }) {
  const { navigation, route, storage } = useScreenNavigation();
  const caseId = 'caseId' in route ? route.caseId : 'ender';
  const [localSelected, setLocalSelected] = useState<Item | null>(null);
  const selected = navigation
    ? route.screen === 'item'
      ? (items.find((item) => item.id === route.itemId) ?? null)
      : null
    : localSelected;
  const returnContext = 'returnTo' in route && route.returnTo ? { returnTo: route.returnTo } : {};
  const setSelected = (item: Item | null, replace = false) => {
    if (navigation)
      navigation.go(
        item
          ? {
              screen: 'item',
              caseId,
              ...('instanceId' in route ? { instanceId: route.instanceId } : {}),
              ...returnContext,
              itemId: item.id,
            }
          : {
              screen: 'case',
              caseId,
              ...('instanceId' in route ? { instanceId: route.instanceId } : {}),
              ...returnContext,
            },
        replace,
      );
    else setLocalSelected(item);
  };
  const element = useRef<HTMLElement>(null);
  useEffect(() => {
    const container = element.current?.parentElement;
    if (!container || !storage) return;
    const key = `screen:case:${caseId}:scroll`;
    const top = storage.read(key, (value) =>
      typeof value === 'number' && value >= 0 && value < 1_000_000 ? value : 0,
    );
    container.scrollTop = top ?? 0;
    const save = () => storage.write(key, container.scrollTop);
    container.addEventListener('scroll', save, { passive: true });
    return () => {
      save();
      container.removeEventListener('scroll', save);
    };
  }, [caseId, storage]);
  const selectedIndex = selected ? items.findIndex((item) => item.id === selected.id) : -1;
  const browse = (offset: number) =>
    setSelected(items[(selectedIndex + offset + items.length) % items.length]!, true);
  return (
    <section ref={element} className="catalog" aria-labelledby="catalog-title">
      <header className="catalog__header">
        <h2 id="catalog-title">Предметы в сундуке</h2>
        <span className="catalog__count">{items.length}</span>
      </header>
      <ul className="catalog__items">
        {items.map((item) => (
          <li className={`item item--${item.rarity}`} key={item.id}>
            <button
              className="item__inspect"
              type="button"
              onClick={() => setSelected(item)}
              aria-label={`Рассмотреть ${item.title}`}
              aria-haspopup="dialog"
            >
              <div className="item__preview">
                <ItemArt item={item} size={120} />
              </div>
              <h3 className="item__title">{item.title}</h3>
              <span className="item__rarity">{rarityLabels[item.rarity]}</span>
            </button>
          </li>
        ))}
      </ul>
      {navigation && route.screen === 'item' && !selected && (
        <div className="feedback" role="alert">
          <p>Предмет не найден в этом сундуке.</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setSelected(null, true)}
          >
            К содержимому
          </button>
        </div>
      )}
      {selected && (
        <ItemDetails
          item={selected}
          onClose={() => setSelected(null, true)}
          browse={{
            index: selectedIndex,
            total: items.length,
            previous: () => browse(-1),
            next: () => browse(1),
          }}
        />
      )}
    </section>
  );
}
