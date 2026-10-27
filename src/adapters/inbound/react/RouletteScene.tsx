import { useCasePresentation } from './case-presentation.ts';
import { PresentationHost } from './PresentationHost.tsx';

/**
 * The strip and the pointer share one stage box: the canvas fills it and the pointer is its
 * horizontal centre, which is where the canvas lands the prize card. No transform scales either.
 */
export function RouletteScene({
  active,
  element,
}: {
  readonly active: boolean;
  readonly element?: HTMLElement;
}) {
  const casePresentation = useCasePresentation();
  return (
    <section className="roulette-scene" hidden={!active} aria-label="Рулетка">
      <header className="roulette-heading">
        <p className="eyebrow">{casePresentation.collection}</p>
        <h2>{casePresentation.title}</h2>
        <p>Сундук открыт. Что достанется тебе?</p>
      </header>
      <div className="roulette-stage">
        <div className="roulette-beam" aria-hidden="true" />
        <PresentationHost className="game-viewport__roulette" element={element} />
        <div className="roulette-pointer" aria-hidden="true">
          <span />
          <span />
        </div>
      </div>
    </section>
  );
}
