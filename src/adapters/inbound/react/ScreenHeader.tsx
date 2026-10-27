import { createPortal } from 'react-dom';
import type { Navigation, ScreenRoute } from '../../../application/ports/navigation.ts';
import type { SoundPreference } from './SoundControl.tsx';
import { SoundControl } from './SoundControl.tsx';
import { BrandMark } from './BrandMark.tsx';
import { ProfileChip, WalletChip } from './AccountContext.tsx';

type Section = 'inventory' | 'archive' | 'catalog' | 'wallet';

const ICONS: Record<Section, string> = {
  inventory: 'M4 8h16v11H4zM4 8l2-4h12l2 4M10 12h4',
  catalog: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  archive: 'M3 5h18v4H3zM5 9h14v10H5zM10 13h4',
  wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l2-3h12M16 14h2',
};
const SHORT_LABEL: Record<Section, string> = {
  inventory: 'Инвентарь',
  catalog: 'Кейсы',
  archive: 'Архив',
  wallet: 'Кошелёк',
};

const LINKS: readonly {
  readonly id: Section;
  readonly label: string;
  readonly route: ScreenRoute;
}[] = [
  { id: 'inventory', label: 'Инвентарь', route: { screen: 'inventory' } },
  { id: 'catalog', label: 'Все кейсы', route: { screen: 'catalog' } },
  { id: 'archive', label: 'Архив', route: { screen: 'archive' } },
  { id: 'wallet', label: 'Кошелёк', route: { screen: 'wallet' } },
];

export function ScreenHeader({
  navigation,
  active,
  archiveCount,
  soundPreference,
}: {
  readonly navigation?: Navigation;
  readonly active: Section;
  readonly archiveCount?: number;
  readonly soundPreference?: SoundPreference;
}) {
  return (
    <header className="screen-header">
      <a
        className="screen-header__brand"
        aria-label="Voxel Vault"
        href="#/inventory"
        onClick={(event) => {
          if (!navigation) return;
          event.preventDefault();
          navigation.go({ screen: 'inventory' });
        }}
      >
        <span className="screen-header__mark">
          <BrandMark />
        </span>
        <img
          className="screen-header__wordmark"
          src="/images/voxel-vault-wordmark.png"
          alt="Voxel Vault"
        />
      </a>
      <nav className="screen-header__nav" aria-label="Разделы">
        {LINKS.map((link) => (
          <button
            key={link.id}
            type="button"
            aria-current={active === link.id ? 'page' : undefined}
            onClick={() => navigation?.go(link.route)}
          >
            {link.label}
            {link.id === 'archive' && archiveCount !== undefined && <span>{archiveCount}</span>}
          </button>
        ))}
      </nav>
      <div className="screen-header__tools">
        <button
          className="screen-header__search"
          type="button"
          aria-label="Поиск по сайту"
          onClick={() => window.dispatchEvent(new Event('voxel:open-search'))}
        >
          <span aria-hidden="true">⌕</span>
          <span>Поиск</span>
          <kbd>⌘K</kbd>
        </button>
        {soundPreference && <SoundControl preference={soundPreference} />}
        <WalletChip onOpenWallet={() => navigation?.go({ screen: 'wallet' })} />
        <ProfileChip />
      </div>
      {/* On body: .intro-scene__top is a transformed, z-indexed ancestor that would clip, animate and under-stack a fixed bar. */}
      {typeof document !== 'undefined' &&
        createPortal(
          <nav className="tab-bar" aria-label="Разделы">
            {LINKS.map((link) => (
              <button
                key={link.id}
                type="button"
                aria-current={active === link.id ? 'page' : undefined}
                onClick={() => navigation?.go(link.route)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={ICONS[link.id]} />
                </svg>
                <span>{SHORT_LABEL[link.id]}</span>
                {link.id === 'archive' && !!archiveCount && (
                  <b aria-label={`Всего: ${archiveCount}`}>{archiveCount}</b>
                )}
              </button>
            ))}
          </nav>,
          document.body,
        )}
    </header>
  );
}
