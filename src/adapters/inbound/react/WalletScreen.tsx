import { useEffect, useRef, useState } from 'react';
import type { PlayerWallet, WalletTransaction } from '../../../application/ports/player-wallet.ts';
import type { Navigation } from '../../../application/ports/navigation.ts';
import { resourceGlyph, resourceTitle } from '../../../config/resources.ts';
import { ScreenHeader } from './ScreenHeader.tsx';
import { useObservableState } from './use-observable-state.ts';
import type { SoundPreference } from './SoundControl.tsx';

const count = (n: string) => n.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
const purpose = (p: string) => p === 'opening_balance' ? 'Начальный баланс' : p === 'spending' ? 'Списание' : p === 'buyback' ? 'Выкуп предмета' : 'Начисление';

export function WalletScreen({ wallet, navigation, soundPreference }: { readonly wallet: PlayerWallet; readonly navigation: Navigation; readonly soundPreference?: SoundPreference }) {
  const state = useObservableState(wallet);
  const [asset, setAsset] = useState('currency');
  const [entries, setEntries] = useState<readonly WalletTransaction[]>([]);
  const [next, setNext] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [balancesFailed, setBalancesFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => { const c = new AbortController(); void wallet.load(c.signal).catch(() => { if (!c.signal.aborted) setBalancesFailed(true); }); return () => c.abort(); }, [wallet]);
  useEffect(() => {
    const c = new AbortController(); request.current = c; setEntries([]); setNext(undefined); setFailed(false); setLoading(false);
    if (state.loaded) {
      setLoading(true);
      void wallet.history(asset, undefined, c.signal).then(h => { if (!c.signal.aborted) { setEntries(h.entries); setNext(h.nextCursor); } }, () => { if (!c.signal.aborted) setFailed(true); }).finally(() => { if (!c.signal.aborted) setLoading(false); });
    }
    return () => c.abort();
  }, [wallet, asset, state.loaded, attempt]);
  const more = async () => {
    const c = request.current; if (!next || !c || loading) return; setLoading(true); setFailed(false);
    try { const h = await wallet.history(asset, next, c.signal); if (!c.signal.aborted) { setEntries(old => [...old, ...h.entries.filter(e => !old.some(prior => prior.id === e.id))]); setNext(h.nextCursor); } }
    catch { if (!c.signal.aborted) setFailed(true); }
    finally { if (!c.signal.aborted) setLoading(false); }
  };
  return <main className="page-shell inventory wallet-screen"><div className="inventory__content page-container">
    <ScreenHeader navigation={navigation} active="wallet" soundPreference={soundPreference} />
    <div className="inventory__intro"><div><p className="eyebrow">Монеты и материалы</p><h1>Кошелёк</h1><p>Доступные средства и история операций.</p></div></div>
    {balancesFailed && <p role="alert">Не удалось обновить баланс. <button type="button" onClick={() => { setBalancesFailed(false); void wallet.load().catch(() => setBalancesFailed(true)); }}>Повторить</button></p>}
    {!state.loaded && !balancesFailed && <p role="status">Загружаем кошелёк…</p>}
    <section className="wallet-screen__balances" aria-label="Валюты">
      {state.balances.map(b => <button key={b.asset} type="button" className="wallet-screen__balance" aria-pressed={asset === b.asset} onClick={() => setAsset(b.asset)}>
        <span>{resourceGlyph(b.asset)} {resourceTitle(b.asset)}</span><strong>{count(b.available)}</strong>
        {b.held !== '0' && <small>Зарезервировано: {count(b.held)}</small>}
      </button>)}
    </section>
    <section className="wallet-screen__history" aria-labelledby="wallet-history-title" aria-busy={loading}>
      <h2 id="wallet-history-title">История операций <span>{resourceTitle(asset)}</span></h2>
      {failed && <p role="alert">Не удалось загрузить историю. <button type="button" onClick={() => { if (next) void more(); else setAttempt(n => n + 1); }}>Повторить</button></p>}
      <ol className="wallet-screen__transactions">{entries.map(e => <li key={e.id}>
        <div><strong>{purpose(e.purpose)}</strong><time dateTime={e.at}>{new Date(e.at).toLocaleString('ru-RU')}</time></div>
        <span className={e.direction === 'credit' ? 'wallet-screen__credit' : ''}>{e.direction === 'credit' ? '+' : '−'}{count(e.units)}</span>
      </li>)}</ol>
      {loading && <p role="status">Загружаем операции…</p>}
      {state.loaded && !loading && !failed && entries.length === 0 && <p>Операций с этой валютой пока нет.</p>}
      {next && <button type="button" className="btn btn-transparent" disabled={loading} onClick={() => { void more(); }}>Показать ещё</button>}
    </section>
  </div></main>;
}
