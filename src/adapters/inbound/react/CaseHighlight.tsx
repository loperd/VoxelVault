import { useState } from 'react';
import type { Item } from '../../../domain/item.ts';
import type { RecentFind } from '../../../application/ports/recent-find.ts';
import { useScreenNavigation } from './NavigationContext.tsx';
import { useObservableState } from './use-observable-state.ts';
import { ItemDetails, rarityLabels } from './ItemDetails.tsx';

export function CaseHighlight({
  item,
  recent = false,
  disabled = false,
}: {
  readonly item: Item;
  readonly recent?: boolean;
  readonly disabled?: boolean;
}) {
  const { navigation, route } = useScreenNavigation();
  const [inspecting, setInspecting] = useState(false);
  return (
    <aside className="case-featured" inert={disabled}>
      <p className="eyebrow">{recent ? 'Последняя находка' : 'Среди сокровищ'}</p>
      <button
        type="button"
        className="case-featured__inspect"
        aria-label={`Рассмотреть ${item.title}`}
        aria-haspopup="dialog"
        onClick={() => {
          if (navigation && 'caseId' in route)
            navigation.go({
              screen: 'item',
              caseId: route.caseId,
              ...('instanceId' in route ? { instanceId: route.instanceId } : {}),
              itemId: item.id,
            });
          else setInspecting(true);
        }}
      >
        <img src={item.image} alt="" width="88" height="88" />
        <span className={`case-featured__rarity case-featured__rarity--${item.rarity}`}>
          {rarityLabels[item.rarity]}
        </span>
        <strong>{item.title}</strong>
        <span className="case-featured__hint">Рассмотреть ↗</span>
      </button>
      {inspecting && <ItemDetails item={item} onClose={() => setInspecting(false)} />}
    </aside>
  );
}

export function RecentFindHighlight({
  source,
  fallback,
  disabled,
}: {
  readonly source: RecentFind;
  readonly fallback?: Item;
  readonly disabled: boolean;
}) {
  const state = useObservableState(source);
  const item = state.item ?? fallback;
  return item ? (
    <CaseHighlight item={item} recent={Boolean(state.item)} disabled={disabled} />
  ) : null;
}
