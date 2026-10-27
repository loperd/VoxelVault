import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../adapters/inbound/react/styles.css';
import { Catalog } from '../adapters/inbound/react/Catalog.tsx';
import { ItemArt, ItemPresentationContext } from '../adapters/inbound/react/ItemArt.tsx';
import { PrizeScene } from '../adapters/inbound/react/PrizeScene.tsx';
import { CanvasRoulette } from '../adapters/outbound/browser/canvas-roulette.ts';
import { ThreeItemPresentation } from '../adapters/outbound/items/three-item-presentation.ts';
import { ITEM_STATES, type ItemState } from '../domain/case-instance.ts';
import type { Item } from '../domain/item.ts';
import { createSpinPlan } from '../domain/spin-plan.ts';
import { buildStrip, ensureTarget } from '../domain/strip.ts';

// Item lab: the three reference models on the real screens (catalog, inspection, roulette, reward).
// No server: the "outcome" is picked here; the app takes it from the server and only draws it.
const baseUrl = new URL('.', document.baseURI);
const art = new ThreeItemPresentation(document, baseUrl);
const icon = (name: string) => `/static/icon/${name}.png`;
const ITEMS: readonly Item[] = [
  {
    id: 'traveler-pickaxe',
    title: 'Каменная кирка с рунами',
    image: icon('eca4d8fb36546ac643bb2a27584b4522034e358a'),
    rarity: 'rare',
    displayWeight: 20,
  },
  {
    id: 'ender-void-eye',
    title: 'Око пустоты',
    image: icon('672410c017e7b495ddcaab02fa638e1c80443fdd'),
    rarity: 'uncommon',
    displayWeight: 25,
  },
  {
    id: 'privilege-knight',
    title: 'Привилегия «Рыцарь»',
    image: '/images/privileges/knight.webp',
    rarity: 'epic',
    displayWeight: 5,
  },
  {
    id: 'relic-phase-blade',
    title: 'relic-phase-blade',
    image: icon('7de3bb62825c11f969be67b4720a6fb5eaba9d69'),
    rarity: 'epic',
    displayWeight: 5,
  },
  {
    id: 'relic-core-fragment',
    title: 'relic-core-fragment',
    image: icon('7de3bb62825c11f969be67b4720a6fb5eaba9d69'),
    rarity: 'epic',
    displayWeight: 5,
  },
  {
    id: 'relic-relay',
    title: 'relic-relay',
    image: icon('7de3bb62825c11f969be67b4720a6fb5eaba9d69'),
    rarity: 'epic',
    displayWeight: 5,
  },
  {
    id: 'relic-probe',
    title: 'relic-probe',
    image: icon('7de3bb62825c11f969be67b4720a6fb5eaba9d69'),
    rarity: 'epic',
    displayWeight: 5,
  },
  {
    id: 'relic-capacitor',
    title: 'relic-capacitor',
    image: icon('7de3bb62825c11f969be67b4720a6fb5eaba9d69'),
    rarity: 'epic',
    displayWeight: 5,
  },
  {
    id: 'dragon-ember',
    title: 'dragon-ember',
    image: icon('7de3bb62825c11f969be67b4720a6fb5eaba9d69'),
    rarity: 'epic',
    displayWeight: 5,
  },
  {
    id: 'dragon-scale',
    title: 'dragon-scale',
    image: icon('7de3bb62825c11f969be67b4720a6fb5eaba9d69'),
    rarity: 'epic',
    displayWeight: 5,
  },
  {
    id: 'image-1',
    title: 'Без модели: картинка',
    image: icon('7de3bb62825c11f969be67b4720a6fb5eaba9d69'),
    rarity: 'common',
    displayWeight: 30,
  },
  {
    id: 'image-2',
    title: 'Без модели: картинка',
    image: icon('33ae616445a689c5fd84b057e8f4441950d37362'),
    rarity: 'epic',
    displayWeight: 10,
  },
];
const roulette = new CanvasRoulette(document, {
  art: (item, signal) => (art.has(item.id) ? art.preview(item.id, signal) : undefined),
});

function Lab() {
  const [prize, setPrize] = useState<Item>(ITEMS[0]!);
  const [condition, setCondition] = useState<ItemState>('intact');
  const [revealed, setRevealed] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const viewport = useRef<HTMLDivElement>(null),
    close = useRef<HTMLButtonElement>(null);
  const spin = async () => {
    setSpinning(true);
    setRevealed(false);
    const random = { next: Math.random },
      abort = new AbortController();
    try {
      if (!roulette.element.isConnected) {
        viewport.current!.append(roulette.element);
        await roulette.prepare(abort.signal);
      }
      const selection = ensureTarget(buildStrip(ITEMS, 40, random), prize, random);
      await roulette.spin(selection, createSpinPlan(selection), abort.signal);
      setRevealed(true);
    } finally {
      setSpinning(false);
    }
  };
  return (
    <main className="lab">
      <h1>Предметы в 3D · эталоны</h1>
      <section aria-labelledby="lab-catalog">
        <h2 id="lab-catalog" className="lab__title">
          Каталог → Overview (нажмите на предмет)
        </h2>
        <Catalog items={ITEMS} />
      </section>
      <section aria-labelledby="lab-roulette">
        <h2 id="lab-roulette" className="lab__title">
          Рулетка → Reward Reveal
        </h2>
        <div className="lab__controls">
          <label>
            Награда{' '}
            <select
              value={prize.id}
              onChange={(event) => setPrize(ITEMS.find((item) => item.id === event.target.value)!)}
            >
              {ITEMS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} ({item.id})
                </option>
              ))}
            </select>
          </label>
          <label>
            Состояние{' '}
            <select
              value={condition}
              onChange={(event) => setCondition(event.target.value as ItemState)}
            >
              {ITEM_STATES.map((state) => (
                <option key={state}>{state}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-transparent"
            disabled={spinning}
            onClick={() => {
              void spin();
            }}
          >
            Крутить
          </button>
          <button type="button" className="btn btn-transparent" onClick={() => setRevealed(true)}>
            Сразу награда
          </button>
        </div>
        <div ref={viewport} className="lab__roulette" />
        <div className="lab__stills" aria-label="Превью для ленты">
          {ITEMS.slice(0, 3).map((item) => (
            <figure key={item.id}>
              <ItemArt item={item} size={120} />
              <figcaption>{item.id}</figcaption>
            </figure>
          ))}
        </div>
      </section>
      {revealed && (
        <PrizeScene
          prize={prize}
          condition={condition}
          actionRef={close}
          onClose={() => setRevealed(false)}
        />
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ItemPresentationContext.Provider value={art}>
      <Lab />
    </ItemPresentationContext.Provider>
  </StrictMode>,
);
window.addEventListener(
  'pagehide',
  () => {
    roulette.dispose();
    art.dispose();
  },
  { once: true },
);
