import { useState } from 'react';

export interface SoundPreference {
  isMuted(): boolean;
  setMuted(muted: boolean): void;
}

export function SoundControl({ preference }: { readonly preference: SoundPreference }) {
  const [muted, setMuted] = useState(() => preference.isMuted());
  return (
    <button
      type="button"
      className="sound-control"
      aria-pressed={!muted}
      aria-label={muted ? 'Включить звук' : 'Выключить звук'}
      onClick={() => {
        preference.setMuted(!muted);
        setMuted(!muted);
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path d="M4 9h4l5-4v14l-5-4H4Z" strokeLinejoin="round" />
        {muted ? (
          <path d="m17 9 5 6m0-6-5 6" strokeLinecap="round" />
        ) : (
          <>
            <path d="M17 8c2 2 2 6 0 8" strokeLinecap="round" />
            <path d="M20 5c4 4 4 10 0 14" strokeLinecap="round" />
          </>
        )}
      </svg>
      <span>Звук {muted ? 'выкл.' : 'вкл.'}</span>
    </button>
  );
}
