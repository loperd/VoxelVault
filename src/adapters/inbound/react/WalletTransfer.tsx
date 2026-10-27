import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  PlayerWallet,
  TransferQuote,
  TransferReceipt,
  WalletCurrency,
} from '../../../application/ports/player-wallet.ts';
import { formatWalletAmount, parseWalletAmount } from '../../../application/wallet-amount.ts';

export function WalletTransfer({
  wallet,
  currency,
  onCommitted,
}: {
  readonly wallet: PlayerWallet;
  readonly currency: WalletCurrency;
  readonly onCommitted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<TransferQuote>();
  const [receipt, setReceipt] = useState<TransferReceipt>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined);
  const confirmationKey = useRef<string | undefined>(undefined);

  useEffect(() => () => request.current?.abort(), []);

  function edit() {
    request.current?.abort();
    setBusy(false);
    setQuote(undefined);
    setReceipt(undefined);
    setError(undefined);
    confirmationKey.current = undefined;
  }

  async function calculate(event: FormEvent) {
    event.preventDefault();
    if (request.current && !request.current.signal.aborted && busy) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError(undefined);
    setQuote(undefined);
    setReceipt(undefined);
    setBusy(true);
    try {
      const units = parseWalletAmount(amount, currency.precision);
      const resolved = await wallet.resolveRecipient(
        currency.asset,
        recipient.trim(),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const result = await wallet.quoteTransfer(
        currency.asset,
        resolved.id,
        units,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.precision !== currency.precision) {
        throw new Error('Параметры валюты изменились. Обновите кошелёк.');
      }
      confirmationKey.current = crypto.randomUUID();
      setQuote(result);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Не удалось рассчитать перевод.');
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function confirm() {
    if (!quote || !confirmationKey.current || busy) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setError(undefined);
    setBusy(true);
    try {
      const result = await wallet.confirmTransfer(
        quote.id,
        confirmationKey.current,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (
        result.currencyId !== currency.asset ||
        result.debitUnits !== quote.debitUnits ||
        result.receiptUnits !== quote.receiptUnits
      ) {
        throw new Error('Ответ перевода не совпадает с котировкой. Обновите историю.');
      }
      setReceipt(result);
      onCommitted();
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Не удалось подтвердить перевод.');
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  if (!currency.canOperate) {
    return (
      <p className="wallet-transfer__notice">Доступ только для просмотра. Переводы недоступны.</p>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-green wallet-transfer__start"
        onClick={() => setOpen(true)}
      >
        Перевести
      </button>
    );
  }
  const format = (units: string) =>
    `${formatWalletAmount(units, currency.precision)} ${currency.code}`;
  return (
    <section className="wallet-transfer" aria-label="Перевод пользователю" aria-busy={busy}>
      <div className="wallet-transfer__heading">
        <h3>Перевод пользователю</h3>
        <button
          type="button"
          className="wallet-transfer__close"
          onClick={() => {
            edit();
            setOpen(false);
          }}
          disabled={busy}
          aria-label="Закрыть перевод"
        >
          ×
        </button>
      </div>
      {receipt ? (
        <div role="status" className="wallet-transfer__success">
          <strong>Перевод выполнен</strong>
          <p>Получателю зачислено {format(receipt.receiptUnits)}.</p>
          <button type="button" className="btn btn-green" onClick={edit}>
            Новый перевод
          </button>
        </div>
      ) : (
        <>
          <form onSubmit={(event) => void calculate(event)}>
            <label>
              Получатель
              <input
                name="recipient"
                autoComplete="off"
                value={recipient}
                onChange={(event) => {
                  edit();
                  setRecipient(event.target.value);
                }}
                placeholder="Точный ник или ID"
                maxLength={162}
                required
                disabled={busy}
              />
            </label>
            <label>
              Сумма, {currency.code}
              <input
                name="amount"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(event) => {
                  edit();
                  setAmount(event.target.value);
                }}
                placeholder={currency.precision === 0 ? '0' : '0,00'}
                maxLength={80}
                required
                disabled={busy}
              />
            </label>
            {!quote && (
              <button type="submit" className="btn btn-green" disabled={busy}>
                {busy ? 'Рассчитываем…' : 'Рассчитать перевод'}
              </button>
            )}
          </form>
          {quote && (
            <div className="wallet-transfer__quote">
              <p>
                Получатель:{' '}
                <strong>
                  <bdi>{quote.recipient.displayName}</bdi>
                </strong>{' '}
                <span>
                  <bdi>@{quote.recipient.handle}</bdi>
                </span>
              </p>
              <dl>
                {quote.commission.map((fee) => (
                  <div key={fee.ruleId}>
                    <dt>
                      {fee.ruleId === 'general-tax' ? 'Общий налог' : 'Комиссия'}
                      <small>{fee.imposition === 'inside' ? 'из суммы' : 'сверх суммы'}</small>
                    </dt>
                    <dd>{format(fee.units)}</dd>
                  </div>
                ))}
                <div>
                  <dt>Будет списано</dt>
                  <dd>{format(quote.debitUnits)}</dd>
                </div>
                <div className="wallet-transfer__receipt">
                  <dt>Получатель получит</dt>
                  <dd>{format(quote.receiptUnits)}</dd>
                </div>
              </dl>
              <p className="wallet-transfer__expiry">
                Расчёт действует до{' '}
                <time dateTime={quote.expiresAt}>
                  {new Date(quote.expiresAt).toLocaleTimeString('ru-RU')}
                </time>
                . Средства ещё не списаны.
              </p>
              <button
                type="button"
                className="btn btn-green"
                disabled={busy}
                onClick={() => void confirm()}
              >
                {busy ? 'Подтверждаем…' : 'Подтвердить перевод'}
              </button>
              <button
                type="button"
                className="btn wallet-transfer__secondary"
                disabled={busy}
                onClick={edit}
              >
                Изменить
              </button>
            </div>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
