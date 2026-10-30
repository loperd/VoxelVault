import { useState } from 'react';
import type { CaseInstance } from '../../../domain/case-instance.ts';
import type { CaseVisualTheme, WorldId } from '../../../config/cases.ts';
import type { ChestHandles } from '../../../application/ports/chest-handles.ts';
import type { Guest } from '../../../../packages/blockworld/src/index.ts';
import { PixelWorldBackground } from './PixelWorldBackground.tsx';
import type { CSSProperties } from 'react';
import type { ItemCatalog } from '../../../application/ports/item-catalog.ts';
import type { ChestPreview } from '../../../application/ports/chest-preview.ts';
import type { RouletteSession } from '../../../application/ports/roulette-session.ts';
import type { RecentFind } from '../../../application/ports/recent-find.ts';
import { Catalog } from './Catalog.tsx';
import { ChestPreviewPanel } from './ChestPreviewPanel.tsx';
import { SessionPanel } from './SessionPanel.tsx';
import { GameViewport } from './GameViewport.tsx';
import { useObservableState } from './use-observable-state.ts';
import type { SoundPreference } from './SoundControl.tsx';
import { Button } from './Button.tsx';
import { ErrorNotice } from './ErrorNotice.tsx';

export function App({
  captureWreck,
  catalog,
  session,
  preview,
  sceneElement,
  rouletteElement,
  transitionElement,
  backgroundUrl,
  world,
  onRetryInitialization,
  onOpenGesture,
  soundPreference,
  recentFind,
  onOpenRequest,
  onPrizeClose,
  openLabel,
  availableCaseCount,
  archiveCount,
  casePalette,
  inspectedCase,
}: {
  readonly onOpenRequest?: () => void;
  readonly onPrizeClose?: () => void;
  readonly casePalette?: CaseVisualTheme;
  readonly openLabel?: string;
  /** The case on the screen, by its id: what a pack the player tries is tried on. */
  readonly caseId?: string;
  readonly availableCaseCount?: number;
  readonly archiveCount?: number;
  readonly inspectedCase?: CaseInstance;
  readonly recentFind?: RecentFind;
  readonly soundPreference?: SoundPreference;
  readonly catalog: ItemCatalog;
  readonly session?: RouletteSession;
  readonly preview?: ChestPreview;
  readonly sceneElement?: HTMLElement;
  readonly captureWreck?: () => string | undefined;
  readonly rouletteElement?: HTMLElement;
  readonly transitionElement?: HTMLElement;
  readonly onOpenGesture?: () => void;
  readonly backgroundUrl?: string;
  /** The living world behind the chest, and the chest's handles it may pull. */
  readonly world?: { readonly id: WorldId; readonly chest?: ChestHandles; readonly guest?: Guest };
  readonly onRetryInitialization?: () => Promise<void>;
}) {
  const state = useObservableState(catalog);
  // The roulette and prize screens show the very world the chest was opened in, still.
  const [worldStill, setWorldStill] = useState<string>();
  if (state.phase === 'disposed') return null;
  const worldImage = worldStill ?? backgroundUrl;
  return (
    <main
      className={`page-shell app${session ? ' app--game' : ''}`}
      style={
        {
          ...(casePalette
            ? {
                '--case-accent': casePalette.accent,
                '--case-accent-highlight': casePalette.highlight,
                '--case-accent-deep': casePalette.deep,
                '--case-accent-glow': casePalette.glow,
                '--case-effect': casePalette.accent,
              }
            : {}),
          ...(worldImage ? { '--case-world-image': `url("${worldImage}")` } : {}),
          ...(backgroundUrl
            ? {
                '--case-static-image': `url("${backgroundUrl}")`,
                backgroundImage: `linear-gradient(180deg, rgba(5, 12, 13, 0.42), rgba(5, 12, 13, 0.3) 42%, rgba(5, 12, 13, 0.68)), url("${backgroundUrl}")`,
              }
            : {}),
          // Its own stacking context: the world (z-index -1) sits over the case picture, under everything else.
          isolation: 'isolate',
        } as CSSProperties
      }
    >
      {world && (
        <PixelWorldBackground
          world={world.id}
          chest={world.chest}
          guest={world.guest}
          session={session}
          onStill={setWorldStill}
        />
      )}
      <div className="app__content page-container">
        {!session && (
          <header className="app__header">
            <p className="eyebrow">Minecraft</p>
            <h1>Voxel Vault</h1>
          </header>
        )}
        {preview && <ChestPreviewPanel preview={preview} element={sceneElement} />}
        {session && (
          <GameViewport
            session={session}
            scene={sceneElement}
            roulette={rouletteElement}
            transition={transitionElement}
          />
        )}
        {(state.phase === 'idle' || state.phase === 'loading') && (
          <div className="feedback" role="status" aria-live="polite">
            <span className="loader" aria-hidden="true" />
            <p>Загружаем предметы…</p>
          </div>
        )}
        {state.phase === 'failed' && (
          <ErrorNotice
            title="Не удалось загрузить предметы"
            actions={
              <Button
                onClick={() => {
                  void (onRetryInitialization ? onRetryInitialization() : catalog.retry());
                }}
              >
                Повторить
              </Button>
            }
          >
            <p>Проверьте соединение и попробуйте ещё раз.</p>
          </ErrorNotice>
        )}
        {state.phase === 'ready' &&
          (session ? (
            <SessionPanel
              soundPreference={soundPreference}
              captureWreck={captureWreck}
              inspectedCase={inspectedCase}
              availableCaseCount={availableCaseCount}
              archiveCount={archiveCount}
              onOpenRequest={onOpenRequest}
              onPrizeClose={onPrizeClose}
              openLabel={openLabel}
              recentFind={recentFind}
              session={session}
              items={state.items}
              onOpenGesture={onOpenGesture}
            />
          ) : (
            <Catalog items={state.items} />
          ))}
      </div>
    </main>
  );
}
