import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Player } from '../../../application/ports/auth-gateway.ts';
import { EMPTY_WALLET, type PlayerWallet } from '../../../application/ports/player-wallet.ts';
import { CURRENCY } from '../../../domain/owned-item.ts';
import { resourceGlyph } from '../../../config/resources.ts';
import { useObservableState } from './use-observable-state.ts';

/** The signed-in player and their wallet, for the header of every screen. */
export interface Account {
  readonly player: Player;
  readonly wallet: PlayerWallet;
  signOut(): void;
}

export const AccountContext = createContext<Account | undefined>(undefined);

/** The balance comes from Wallet; the button opens its own section. */
export function WalletChip({ onOpenWallet }: { readonly onOpenWallet: () => void }) {
  const account = useContext(AccountContext);
  const { loaded, balances } = useObservableState(account?.wallet ?? EMPTY_WALLET);
  if (!account) return null;
  const coins = balances.find((b) => b.asset === CURRENCY)?.available ?? '0';
  return (
    <button
      type="button"
      className="header-chip header-chip--wallet"
      title={loaded ? coins : undefined}
      aria-label={`Кошелёк. Монеты: ${loaded ? coins : 'загрузка'}`}
      onClick={onOpenWallet}
    >
      <span aria-hidden="true">{resourceGlyph(CURRENCY)}</span>
      <strong>{loaded ? coins : '…'}</strong>
    </button>
  );
}

/** The player's name in the header; pressing it shows who is signed in and the way out. */
export function ProfileChip() {
  const account = useContext(AccountContext);
  const [open, setOpen] = useOutsideClose();
  if (!account) return null;
  const { player } = account;
  return (
    <div className="header-popover" ref={open.ref}>
      <button
        type="button"
        className="header-chip header-chip--profile"
        aria-expanded={open.value}
        onClick={() => setOpen(!open.value)}
      >
        <span className="header-chip__avatar" aria-hidden="true">
          {[...player.displayName][0]?.toUpperCase() ?? '?'}
        </span>
        <span className="header-chip__name">{player.displayName}</span>
      </button>
      {open.value && (
        <div className="header-popover__panel" role="dialog" aria-label="Профиль">
          <p className="header-profile__name">{player.displayName}</p>
          <p className="header-profile__handle">@{player.handle}</p>
          <button
            type="button"
            className="header-popover__action"
            onClick={() => {
              setOpen(false);
              account.signOut();
            }}
          >
            Выйти
          </button>
        </div>
      )}
    </div>
  );
}

/** Open state that closes on a click outside or on Escape. */
function useOutsideClose() {
  const [value, set] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!value) return;
    const close = (event: Event) => {
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) set(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        set(false);
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape, true);
    };
  }, [value]);
  return [{ value, ref }, set] as const;
}
