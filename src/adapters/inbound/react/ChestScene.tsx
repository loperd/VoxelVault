import { PresentationHost } from './PresentationHost.tsx';

/** The chest's place in the page while it falls and opens; the chest itself is drawn in the world. */
export function ChestScene({
  active,
  element,
}: {
  readonly active: boolean;
  readonly element?: HTMLElement;
}) {
  return (
    <section className="chest-scene" hidden={!active} aria-label="Падение и открытие сундука">
      <PresentationHost className="game-viewport__scene" element={element} />
    </section>
  );
}
