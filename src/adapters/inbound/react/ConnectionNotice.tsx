import { useSyncExternalStore } from 'react';
import type { ConnectionMonitor } from '../../outbound/data/connection-monitor.ts';
import { Button } from './Button.tsx';

/** A chest whose cable has come unplugged. */
function UnpluggedChest() {
  return (
    <svg
      className="offline-notice__art"
      viewBox="0 0 24 14"
      width="144"
      height="84"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="12" height="3" fill="#a7aea9" />
      <rect x="9" y="5" width="12" height="7" fill="#79817b" />
      <rect x="9" y="5" width="12" height="1" fill="#2a302b" />
      <rect x="14" y="4" width="2" height="3" fill="#ffc83d" />
      <rect x="3" y="8" width="3" height="1" fill="#79817b" />
      <rect x="6" y="8" width="1" height="3" fill="#79817b" />
      <rect x="7" y="11" width="2" height="1" fill="#79817b" />
      <rect x="0" y="6" width="3" height="5" fill="#a7aea9" />
      <rect x="1" y="5" width="1" height="1" fill="#e0685c" />
      <rect x="4" y="3" width="1" height="1" fill="#e0685c" />
      <rect x="6" y="5" width="1" height="1" fill="#e0685c" />
    </svg>
  );
}

const COPY = {
  'internet-down': {
    title: 'Связь потерялась',
    text: 'Похоже, пропал интернет. Не переживай: сундуки и награды хранятся на сервере и никуда не денутся. Проверь соединение и обнови страницу.',
  },
  'server-down': {
    title: 'Хранилище не отвечает',
    text: 'Интернет у тебя работает, а сервер сейчас недоступен. Сундуки и награды в безопасности: они хранятся на сервере. Подожди немного и обнови страницу.',
  },
} as const;

/** Full-screen stop above every screen; it clears itself when the monitor sees the server again. */
export function ConnectionNotice({ monitor }: { readonly monitor: ConnectionMonitor }) {
  const state = useSyncExternalStore(monitor.subscribe, monitor.getState, () => 'ok' as const);
  if (state === 'ok') return null;
  const { title, text } = COPY[state];
  return (
    <div className="offline-notice" role="alert">
      <div className="offline-notice__panel">
        <UnpluggedChest />
        <h2 className="offline-notice__title">{title}</h2>
        <p className="offline-notice__text">{text}</p>
        <Button onClick={() => window.location.reload()}>Обновить</Button>
      </div>
    </div>
  );
}
