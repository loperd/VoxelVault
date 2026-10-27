import { useEffect, useRef, useState } from 'react';
import type { PlayerWallet, WalletTransaction } from '../../../application/ports/player-wallet.ts';
import type { Navigation } from '../../../application/ports/navigation.ts';
import { formatWalletAmount } from '../../../application/wallet-amount.ts';
import { ScreenHeader } from './ScreenHeader.tsx';
import { useObservableState } from './use-observable-state.ts';
import type { SoundPreference } from './SoundControl.tsx';
import { WalletTransfer } from './WalletTransfer.tsx';

const purpose = (p: string) =>
  p === 'opening_balance'
    ? 'Начальный баланс'
    : p === 'spending'
      ? 'Списание'
      : p === 'buyback'
        ? 'Выкуп предмета'
        : p === 'transfer'
          ? 'Перевод'
          : 'Начисление';

const transactionStatus = {
  held: 'Холд',
  captured: 'Списано',
  credited: 'Зачислено',
  released: 'Холд снят',
} as const;

export function WalletScreen({
  wallet,
  navigation,
  soundPreference,
}: {
  readonly wallet: PlayerWallet;
  readonly navigation: Navigation;
  readonly soundPreference?: SoundPreference;
}) {
  const state = useObservableState(wallet);
  const [asset, setAsset] = useState('currency');
  const [entries, setEntries] = useState<readonly WalletTransaction[]>([]);
  const [historySource, setHistorySource] = useState<{
    wallet: PlayerWallet;
    accountRevision: number;
    asset: string;
    currencies: typeof state.currencies;
  }>();
  const [next, setNext] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [balancesFailed, setBalancesFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState('');
  const selected = state.currencies.find((currency) => currency.asset === asset);
  const selectedBalance = state.balances.find((balance) => balance.asset === asset);
  const historyCurrent =
    state.loaded &&
    historySource?.wallet === wallet &&
    historySource.accountRevision === state.accountRevision &&
    historySource.asset === asset &&
    historySource.currencies === state.currencies;
  const visibleEntries = historyCurrent ? entries : [];
  useEffect(() => {
    const first = state.currencies[0];
    if (state.loaded && !selected && first) {
      setAsset(first.asset);
    }
  }, [state.loaded, state.currencies, selected]);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const c = new AbortController();
    void wallet.load(c.signal).catch(() => {
      if (!c.signal.aborted) setBalancesFailed(true);
    });
    return () => c.abort();
  }, [wallet]);
  useEffect(() => {
    const c = new AbortController();
    request.current = c;
    setHistorySource({
      wallet,
      accountRevision: state.accountRevision,
      asset,
      currencies: state.currencies,
    });
    setEntries([]);
    setNext(undefined);
    setFailed(false);
    setLoading(false);
    if (state.loaded && selected) {
      setLoading(true);
      void wallet
        .history(asset, undefined, c.signal)
        .then(
          (h) => {
            if (!c.signal.aborted) {
              setEntries(h.entries);
              setNext(h.nextCursor);
            }
          },
          () => {
            if (!c.signal.aborted) setFailed(true);
          },
        )
        .finally(() => {
          if (!c.signal.aborted) setLoading(false);
        });
    }
    return () => c.abort();
  }, [
    wallet,
    asset,
    state.accountRevision,
    state.loaded,
    state.currencies,
    Boolean(selected),
    attempt,
  ]);
  const more = async () => {
    const c = request.current;
    if (!historyCurrent || !next || !c || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const h = await wallet.history(asset, next, c.signal);
      if (!c.signal.aborted) {
        setEntries((old) => [
          ...old,
          ...h.entries.filter((e) => !old.some((prior) => prior.id === e.id)),
        ]);
        setNext(h.nextCursor);
      }
    } catch {
      if (!c.signal.aborted) setFailed(true);
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  };
  return (
    <main className="page-shell inventory wallet-screen">
      <div className="inventory__content page-container">
        <ScreenHeader navigation={navigation} active="wallet" soundPreference={soundPreference} />
        <div className="inventory__intro">
          <div>
            <p className="eyebrow">Баланс и переводы</p>
            <h1>Кошелёк</h1>
            <p>Ваши валюты и история операций.</p>
          </div>
        </div>
        {balancesFailed && (
          <p role="alert">
            Не удалось обновить баланс.{' '}
            <button
              type="button"
              onClick={() => {
                setBalancesFailed(false);
                void wallet.load().catch(() => setBalancesFailed(true));
              }}
            >
              Повторить
            </button>
          </p>
        )}
        {!state.loaded && !balancesFailed && <p role="status">Загружаем кошелёк…</p>}
        <div className="wallet-screen__workspace">
          <section className="wallet-screen__collection" aria-label="Валюты">
            <label className="wallet-screen__search">
              <span className="sr-only">Поиск валюты</span>
              <input
                type="search"
                placeholder="Поиск валюты…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="wallet-screen__balances">
              {state.currencies
                .filter((currency) =>
                  `${currency.name} ${currency.code}`
                    .toLocaleLowerCase()
                    .includes(search.toLocaleLowerCase()),
                )
                .map((currency) => {
                  const b = state.balances.find((balance) => balance.asset === currency.asset);
                  if (!b) return null;
                  return (
                    <button
                      key={b.asset}
                      type="button"
                      className="wallet-screen__balance"
                      aria-pressed={asset === b.asset}
                      onClick={() => setAsset(b.asset)}
                    >
                      <span>
                        <span className="wallet-screen__coin" aria-hidden="true">
                          ◎
                        </span>{' '}
                        {currency.name}
                      </span>
                      <strong>{formatWalletAmount(b.available, currency.precision)}</strong>
                      <small>
                        {currency.code}
                        {!currency.canOperate && ' · Только просмотр'}
                      </small>
                      {b.held !== '0' && (
                        <small>
                          Зарезервировано: {formatWalletAmount(b.held, currency.precision)}
                        </small>
                      )}
                    </button>
                  );
                })}
            </div>
            {state.loaded && state.currencies.length === 0 && <p>Доступных валют пока нет.</p>}
            {state.loaded &&
              state.currencies.length > 0 &&
              !state.currencies.some((currency) =>
                `${currency.name} ${currency.code}`
                  .toLocaleLowerCase()
                  .includes(search.toLocaleLowerCase()),
              ) && <p>Валюты не найдены. Измените поиск.</p>}
          </section>
          <section
            className="wallet-screen__history"
            aria-labelledby="wallet-history-title"
            aria-busy={loading}
          >
            {selected && selectedBalance && (
              <>
                <div className="wallet-screen__selected">
                  <div>
                    <h2>{selected.name}</h2>
                    <span>{selected.code}</span>
                  </div>
                  <strong>
                    {formatWalletAmount(selectedBalance.available, selected.precision)}
                  </strong>
                </div>
                {/* https://react.dev/learn/preserving-and-resetting-state#resetting-a-form-with-a-key */}
                <WalletTransfer
                  key={`${state.accountRevision}:${asset}:${selected.precision}`}
                  wallet={wallet}
                  currency={selected}
                  onCommitted={() => {
                    setAttempt((value) => value + 1);
                    void wallet.load().catch(() => setBalancesFailed(true));
                  }}
                />
              </>
            )}
            <h2 id="wallet-history-title">История операций</h2>
            {historyCurrent && failed && (
              <p role="alert">
                Не удалось загрузить историю.{' '}
                <button
                  type="button"
                  onClick={() => {
                    if (next) void more();
                    else setAttempt((n) => n + 1);
                  }}
                >
                  Повторить
                </button>
              </p>
            )}
            <ol className="wallet-screen__transactions">
              {visibleEntries.map((e) => (
                <li key={e.id}>
                  <div>
                    <strong>{purpose(e.purpose)}</strong>
                    <span className="wallet-screen__transaction-status" data-status={e.status}>
                      {transactionStatus[e.status]}
                    </span>
                    {e.at ? (
                      <time dateTime={e.at}>{new Date(e.at).toLocaleString('ru-RU')}</time>
                    ) : (
                      <span className="wallet-screen__transaction-date">Дата не сохранена</span>
                    )}
                  </div>
                  <span className={e.direction === 'credit' ? 'wallet-screen__credit' : ''}>
                    {e.status === 'credited' ? '+' : e.status === 'captured' ? '−' : ''}
                    {formatWalletAmount(e.units, selected?.precision ?? 0)}
                  </span>
                </li>
              ))}
            </ol>
            {state.loaded && (!historyCurrent || loading) && (
              <p role="status">Загружаем операции…</p>
            )}
            {historyCurrent && !loading && !failed && visibleEntries.length === 0 && (
              <p>Операций с этой валютой пока нет.</p>
            )}
            {historyCurrent && next && (
              <button
                type="button"
                className="btn btn-transparent"
                disabled={loading}
                onClick={() => {
                  void more();
                }}
              >
                Показать ещё
              </button>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
