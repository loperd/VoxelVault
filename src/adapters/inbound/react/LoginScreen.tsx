import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  AuthError,
  type AuthGateway,
  type AuthProviders,
  type Player,
} from '../../../application/ports/auth-gateway.ts';
import { Button } from './Button.tsx';

type Mode = 'sign-in' | 'register';

const MESSAGES: Readonly<Record<AuthError['code'], string>> = {
  UNAVAILABLE: 'Сервер не отвечает. Попробуйте ещё раз через минуту.',
  HANDLE_TAKEN: 'Этот ник уже занят — выберите другой или войдите.',
  INVALID_INPUT: 'Ник: от 3 символов, латиница, цифры, точка, дефис или подчёркивание.',
  UNKNOWN_ACCOUNT: 'Аккаунт с таким ником не найден. Можно создать новый.',
  CANCELLED: 'Вход отменён. Нажмите кнопку ещё раз, когда будете готовы.',
  UNSUPPORTED:
    'Этот браузер не поддерживает ключи доступа. Войдите через Telegram или откройте сайт в другом браузере.',
  REJECTED: 'Ключ доступа не подошёл. Попробуйте ещё раз.',
};

/**
 * The way in: a passkey (Face ID, Touch ID, Windows Hello, a phone or a security key) or Telegram.
 * No passwords. A passkey account is a handle plus a name; the passkey itself never leaves the device.
 */
export function LoginScreen({
  auth,
  onSignedIn,
}: {
  readonly auth: AuthGateway;
  readonly onSignedIn: (player: Player) => void;
}) {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [providers, setProviders] = useState<AuthProviders>({ passkey: true, telegram: false });
  const ids = { handle: useId(), name: useId(), error: useId() };

  useEffect(() => {
    const abort = new AbortController();
    auth.providers(abort.signal).then(setProviders, () => {
      /* passkeys stay available; Telegram stays hidden */
    });
    return () => abort.abort();
  }, [auth]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const player =
        mode === 'register'
          ? await auth.register(handle.trim().toLowerCase(), displayName.trim() || handle.trim())
          : await auth.signIn(handle.trim().toLowerCase());
      onSignedIn(player);
    } catch (failure) {
      setError(failure instanceof AuthError ? MESSAGES[failure.code] : MESSAGES.UNAVAILABLE);
      if (failure instanceof AuthError && failure.code === 'UNKNOWN_ACCOUNT') setMode('register');
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(undefined);
  };

  return (
    <main className="page-shell login">
      <section className="login__panel" aria-labelledby="login-title">
        <header className="login__brand">
          <span className="login__mark">
            <img src="/images/voxel-vault-symbol.png" alt="" aria-hidden="true" />
          </span>
          <img
            className="login__wordmark"
            src="/images/voxel-vault-wordmark.png"
            alt="Voxel Vault"
          />
        </header>
        <p className="login__eyebrow">{mode === 'register' ? 'Новый игрок' : 'С возвращением'}</p>
        <h1 id="login-title" className="login__title">
          {mode === 'register' ? 'Создать аккаунт' : 'Вход в хранилище'}
        </h1>
        <p className="login__lead">
          {mode === 'register'
            ? 'Придумайте ник — вход будет по ключу доступа: отпечаток, лицо или PIN устройства. Пароль не нужен.'
            : 'Ваши сундуки и награды ждут. Войдите ключом доступа или через Telegram.'}
        </p>

        <form
          className="login__form"
          onSubmit={(event) => {
            void submit(event);
          }}
          noValidate
          aria-describedby={error ? ids.error : undefined}
        >
          <label className="login__field" htmlFor={ids.handle}>
            <span>Ник</span>
            <input
              id={ids.handle}
              name="username"
              autoComplete="username webauthn"
              autoCapitalize="none"
              spellCheck={false}
              required
              minLength={3}
              maxLength={80}
              pattern="[a-z0-9][a-z0-9._\-]*"
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="steve"
              disabled={busy}
            />
          </label>
          {mode === 'register' && (
            <label className="login__field" htmlFor={ids.name}>
              <span>
                Имя на сервере <small>необязательно</small>
              </span>
              <input
                id={ids.name}
                name="nickname"
                autoComplete="nickname"
                maxLength={160}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Стив"
                disabled={busy}
              />
            </label>
          )}
          {error && (
            <p id={ids.error} className="login__error" role="alert">
              {error}
            </p>
          )}
          <Button
            type="submit"
            className="login__submit"
            disabled={busy || handle.trim().length < 3}
          >
            {busy ? 'Ждём ключ…' : mode === 'register' ? 'Создать ключ доступа' : 'Войти по ключу'}
          </Button>
        </form>

        {providers.telegram && (
          <>
            <div className="login__divider" role="presentation">
              <span>или</span>
            </div>
            <a className="btn btn-transparent login__telegram" href={auth.telegramUrl}>
              <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18">
                <path
                  fill="currentColor"
                  d="M21.9 4.6 18.7 19.7c-.2 1-.9 1.3-1.7.8l-4.8-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.5 13.5l-4.7-1.5c-1-.3-1-1 .2-1.5L20.5 3.4c.9-.3 1.6.2 1.4 1.2z"
                />
              </svg>
              Войти через Telegram
            </a>
          </>
        )}

        <p className="login__switch">
          {mode === 'register' ? (
            <>
              Уже есть аккаунт?{' '}
              <button type="button" onClick={() => switchMode('sign-in')}>
                Войти
              </button>
            </>
          ) : (
            <>
              Впервые здесь?{' '}
              <button type="button" onClick={() => switchMode('register')}>
                Создать аккаунт
              </button>
            </>
          )}
        </p>
      </section>
    </main>
  );
}
