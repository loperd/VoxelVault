import type { Navigation } from '../../../application/ports/navigation.ts';

/** The inventory holds two things: the chests and the items they dropped. */
export function InventoryTabs({
  navigation,
  active,
  chests,
  items,
}: {
  readonly navigation: Navigation;
  readonly active: 'chests' | 'items';
  readonly chests?: number;
  readonly items?: number;
}) {
  const tab = (id: 'chests' | 'items', label: string, count?: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={active === id}
      onClick={() => {
        if (active !== id) navigation.go({ screen: id === 'chests' ? 'inventory' : 'items' });
      }}
    >
      {label}
      {count !== undefined && <span>{count}</span>}
    </button>
  );
  return (
    <div className="inventory-tabs" role="tablist" aria-label="Инвентарь">
      {tab('chests', 'Сундуки', chests)}
      {tab('items', 'Предметы', items)}
    </div>
  );
}
