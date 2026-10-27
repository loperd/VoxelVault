import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ChestHandles } from '../../../application/ports/chest-handles.ts';
import type { WorldId } from '../../../config/cases.ts';
import { BlockView, type Guest } from '../../../../packages/blockworld/src/index.ts';
import { BLOCK_WORLDS } from '../../outbound/worlds/index.ts';
import { loadPackWorld, PACK_LIGHT, type PackWorld } from '../../outbound/worlds/packs.ts';
import type { RouletteSession } from '../../../application/ports/roulette-session.ts';
import { useObservableState } from './use-observable-state.ts';

const LIVE_STATE = { phase: 'ready' };
const ALWAYS_LIVE = { getState: () => LIVE_STATE, subscribe: (_listener: () => void) => () => {} };

const HOST: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: -1,
  pointerEvents: 'none',
  overflow: 'hidden',
};
// The same shade the still case picture had, so the interface reads over a living world; laid by
// the world over itself and under the chest, so the chest is never dimmed.
export const VEIL = { color: '#050c0d', top: 0.38, middle: 0.18, bottom: 0.62 };
// A pack may be lit bright (a golden hour's sky behind the header and the case's text): a deeper
// veil over its upper half and the middle (the chest's caption) keeps the interface readable; the pack's light itself is left as it is.
const PACK_VEIL = { ...VEIL, top: 0.72, middle: 0.52 };

/** What became of the world asked for (`pack`, none for the case's own): a pack loads first, and may fail. */
export type WorldStatus = { readonly pack?: string } & (
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'ready'; readonly lighting?: PackWorld['lighting'] }
);

/** The phases a game screen covers the world in: it is kept, but spends nothing. */
export const COVERED_PHASES: readonly string[] = [
  'spinning',
  'settling',
  'revealing',
  'prize-visible',
  'destroyed',
  'disposed',
];

/**
 * The world, the base everything happens in. The chest is its guest: the world stands it on its
 * ground, drops it under its physics and draws it with its camera; it may pull the chest's handles
 * (wind, tremor, light). A world still in 2D gets a see-through 3D ground over it for the chest.
 * Without WebGL the case picture stays visible. A world pack, if one is given, stands in for the
 * case's world: loaded for this view, lit as `lighting` names (one of its choices), else in its own light.
 */
export function PixelWorldBackground({
  world,
  pack,
  lighting,
  chest,
  guest,
  onStill,
  onStatus,
  session,
}: {
  readonly world: WorldId;
  readonly pack?: string;
  readonly lighting?: string;
  readonly chest?: ChestHandles;
  readonly guest?: Guest;
  readonly session?: RouletteSession;
  /** A still of this world (without the chest), for screens that show a picture of it: the roulette, the prize. */
  readonly onStill?: (image: string) => void;
  readonly onStatus?: (status: WorldStatus) => void;
}) {
  const state = useObservableState<{ readonly phase: string }>(session ?? ALWAYS_LIVE);
  const active = !COVERED_PHASES.includes(state.phase);
  const host = useRef<HTMLDivElement>(null);
  const [views, setViews] = useState<Views>({});
  const callbacks = useRef({ onStill, onStatus });
  callbacks.current = { onStill, onStatus };
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const made: Views = {},
      loading = new AbortController();
    const view = element.ownerDocument.defaultView ?? window;
    let frame = 0;
    const show = () => {
      setViews(made);
      // Once it has drawn: the same world, still, for the screens that follow the opening.
      frame = view.requestAnimationFrame(() => {
        frame = view.requestAnimationFrame(() => {
          try {
            const still = made.stage?.snapshot('image/jpeg', 0.82, { guests: false });
            if (still && still.length > 64) callbacks.current.onStill?.(still);
          } catch (error) {
            console.warn('No still of the world; the case picture stays.', error);
          }
        });
      });
    };
    const showCaseWorld = () => {
      try {
        made.stage = new BlockView(element, BLOCK_WORLDS[world], { veil: VEIL });
        return true;
      } catch (error) {
        console.warn('The world is unavailable; the case picture stays.', error);
        return false;
      } finally {
        show();
      }
    };
    const failed = (error: unknown) =>
      ({
        pack,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }) as const;
    if (pack) {
      callbacks.current.onStatus?.({ pack, status: 'loading' });
      loadPackWorld(pack, { signal: loading.signal })
        .then((loaded) => {
          // Given up while it loaded: it is let go, never shown over the world that replaced it.
          if (loading.signal.aborted) {
            loaded.assets.release();
            return;
          }
          made.pack = loaded;
          try {
            made.stage = new BlockView(element, loaded.stage, { veil: PACK_VEIL });
          } catch (error) {
            made.pack = undefined;
            loaded.assets.release();
            throw error;
          }
          made.lit = PACK_LIGHT;
          show();
          callbacks.current.onStatus?.({ pack, status: 'ready', lighting: loaded.lighting });
        })
        .catch((error: unknown) => {
          if (loading.signal.aborted) return;
          // The chest still needs a world to stand in: the case's own, and the player is told why.
          console.warn(
            `The world pack "${pack}" is unavailable; the case's world stands in.`,
            error,
          );
          showCaseWorld();
          callbacks.current.onStatus?.(failed(error));
        });
    } else {
      // Made before it is reported: `onStatus?.(…)` evaluates nothing when there is no listener.
      const shown = showCaseWorld();
      callbacks.current.onStatus?.(
        shown ? { status: 'ready' } : failed(new Error('WebGL is unavailable.')),
      );
    }
    return () => {
      loading.abort();
      view.cancelAnimationFrame(frame);
      made.stage?.dispose();
      // The view gave back what it borrowed; nothing else uses this load.
      made.pack?.assets.release();
      setViews({});
    };
  }, [world, pack]);
  useEffect(() => {
    const { stage } = views;
    stage?.hold(chest);
    return () => {
      stage?.hold(undefined);
    };
  }, [chest, views]);
  useEffect(() => {
    const { stage } = views;
    if (!guest || !stage) return;
    stage.admit(guest);
    return () => stage.dismiss(guest);
  }, [guest, views]);
  useEffect(() => {
    views.stage?.setActive(active);
  }, [active, views]);
  useEffect(() => {
    // Re-lit (a remesh) only when the choice changes: no choice, or one the pack lacks, is its own light.
    const { stage, pack: loaded } = views;
    if (!stage || !loaded) return;
    const name = loaded.lighting.some((choice) => choice.name === lighting)
      ? lighting!
      : PACK_LIGHT;
    if (name === views.lit) return;
    try {
      stage.setLighting(loaded.preset(name));
      views.lit = name;
    } catch (error) {
      console.warn(`The lighting "${name}" could not be applied.`, error);
    }
  }, [lighting, views]);
  return <div ref={host} style={HOST} aria-hidden="true" />;
}

interface Views {
  stage?: BlockView<ChestHandles>;
  pack?: PackWorld;
  lit?: string;
}
