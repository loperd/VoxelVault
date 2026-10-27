import type { RouletteSession } from '../../../application/ports/roulette-session.ts';
import { useObservableState } from './use-observable-state.ts';
import { ChestScene } from './ChestScene.tsx';
import { RouletteScene } from './RouletteScene.tsx';
import { PresentationHost } from './PresentationHost.tsx';
import { screenScene } from './screen-scene.ts';
import { CONTENT_EXIT_SECONDS } from '../../outbound/browser/scene-timing.ts';
import type { CSSProperties } from 'react';

export function GameViewport({
  session,
  scene,
  roulette,
  transition,
}: {
  readonly session: RouletteSession;
  readonly scene?: HTMLElement;
  readonly roulette?: HTMLElement;
  readonly transition?: HTMLElement;
}) {
  const state = useObservableState(session);
  const active = screenScene(state.phase);
  const preview = active === 'intro';
  // Hosts stay mounted during loading and every game phase; React does not own their children.
  return (
    <section
      className={`game-viewport${preview && state.phase !== 'clearing' ? ' game-viewport--intro' : ''}${state.phase === 'clearing' ? ' game-viewport--clearing' : ''}`}
      style={{ '--content-exit-duration': `${CONTENT_EXIT_SECONDS}s` } as CSSProperties}
      aria-label="Сундук"
      hidden={!preview && active !== 'chest' && active !== 'roulette'}
    >
      <ChestScene active={preview || active === 'chest'} element={scene} />
      <RouletteScene active={active === 'roulette'} element={roulette} />
      <PresentationHost className="transition-scene" element={transition} />
    </section>
  );
}
