import { ChestIndicators } from './ChestIndicators.tsx';
import { CASES } from '../../../config/cases.ts';
import type { CaseInstance } from '../../../domain/case-instance.ts';
import type { CSSProperties, Ref } from 'react';
import type { Item } from '../../../domain/item.ts';
import { CONTENT_EXIT_SECONDS } from '../../outbound/browser/scene-timing.ts';
import { useScreenNavigation } from './NavigationContext.tsx';
import { Catalog } from './Catalog.tsx';
import { useCasePresentation } from './case-presentation.ts';
import type { RecentFind } from '../../../application/ports/recent-find.ts';
import { CaseHighlight, RecentFindHighlight } from './CaseHighlight.tsx';
import { Button } from './Button.tsx';
import { ScreenHeader } from './ScreenHeader.tsx';
import type { SoundPreference } from './SoundControl.tsx';

export function IntroScene({
  items,
  phase,
  actionRef,
  onOpen,
  recentFind,
  openLabel = 'Открыть сундук',
  availableCaseCount,
  archiveCount,
  inspectedCase,
  soundPreference,
}: {
  readonly soundPreference?: SoundPreference;
  readonly openLabel?: string;
  readonly availableCaseCount?: number;
  readonly archiveCount?: number;
  readonly inspectedCase?: CaseInstance;
  readonly recentFind?: RecentFind;
  readonly items: readonly Item[];
  readonly phase: 'ready' | 'clearing' | 'resetting';
  readonly actionRef: Ref<HTMLButtonElement>;
  readonly onOpen: () => void;
}) {
  const { navigation, route } = useScreenNavigation();
  // The tab that led here stays lit: archive and catalog pass it along as returnTo.
  const origin = 'returnTo' in route ? route.returnTo : undefined;
  const casePresentation = useCasePresentation();
  const featured = items.find((item) => item.rarity === 'legendary');
  const inspectedProfile = CASES.find((value) => value.id === inspectedCase?.caseId)?.model
    .modifications;
  return (
    <section
      className={`intro-scene intro-scene--${phase}`}
      aria-label="Открытие сундука"
      style={{ '--content-exit-duration': `${CONTENT_EXIT_SECONDS}s` } as CSSProperties}
    >
      <div className="intro-scene__top">
        <div className="case-atmosphere" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        <ScreenHeader
          navigation={navigation}
          active={origin ?? 'inventory'}
          archiveCount={archiveCount}
          soundPreference={soundPreference}
        />
        <div className="case-heading">
          <p className="eyebrow">{casePresentation.collection}</p>
          <h1>{casePresentation.title}</h1>
          <p className="intro-scene__description">{casePresentation.description}</p>
        </div>
        {recentFind ? (
          <RecentFindHighlight
            source={recentFind}
            fallback={featured}
            disabled={phase !== 'ready'}
          />
        ) : (
          featured && <CaseHighlight item={featured} disabled={phase !== 'ready'} />
        )}
      </div>
      <div className="intro-scene__bottom" inert={phase !== 'ready'}>
        <div className="case-open-bar">
          {
            <div className="case-open-bar__copy">
              <span className="eyebrow">
                {availableCaseCount === undefined ? 'Что скрывается внутри?' : 'Твоя коллекция'}
              </span>
              {availableCaseCount === undefined ? (
                <p>Один сундук. Твоя следующая находка.</p>
              ) : (
                <p className="case-owned-count">
                  <span>Доступно к открытию:</span>
                  <strong>{availableCaseCount}</strong>
                </p>
              )}
              {inspectedCase && inspectedProfile && (
                <ChestIndicators
                  appearance={inspectedCase.appearance}
                  profile={inspectedProfile}
                  status={inspectedCase.status}
                  showCondition={false}
                  showFeatures={false}
                />
              )}
            </div>
          }
          <div className="actions">
            <Button ref={actionRef} disabled={phase !== 'ready'} onClick={onOpen}>
              {openLabel}
            </Button>
          </div>
        </div>
        <div className="intro-scene__catalog">
          <Catalog items={items} />
        </div>
      </div>
    </section>
  );
}
