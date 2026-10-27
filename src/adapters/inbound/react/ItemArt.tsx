import { createContext, useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import type {
  ItemInspection,
  ItemPresentation,
} from '../../../application/ports/item-presentation.ts';
import type { ItemState } from '../../../domain/case-instance.ts';
import type { Item } from '../../../domain/item.ts';

/** Absent (tests, pages without WebGL wiring): every item shows its image. */
export const ItemPresentationContext = createContext<ItemPresentation | undefined>(undefined);

/**
 * An item's picture, the same model on every screen: a still in lists, the live model to turn when
 * `live` (the still holds its place until the first frame). Items without a model show their image.
 */
export function ItemArt({
  item,
  size,
  live = false,
  condition,
}: {
  readonly item: Pick<Item, 'id' | 'image'>;
  readonly size: number;
  readonly live?: boolean;
  readonly condition?: ItemState;
}) {
  const presentation = useContext(ItemPresentationContext);
  const [failed, setFailed] = useState(false);
  if (!presentation?.has(item.id) || failed)
    return <img src={item.image} alt="" width={size} height={size} loading="lazy" />;
  return live ? (
    <LiveItem
      presentation={presentation}
      id={item.id}
      size={size}
      condition={condition}
      onFail={() => setFailed(true)}
    />
  ) : (
    <ItemStill
      presentation={presentation}
      id={item.id}
      size={size}
      condition={condition}
      onFail={() => setFailed(true)}
    />
  );
}

function ItemStill({
  presentation,
  id,
  size,
  condition,
  onFail,
}: {
  readonly presentation: ItemPresentation;
  readonly id: string;
  readonly size: number;
  readonly condition?: ItemState;
  readonly onFail: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    presentation.preview(id, abort.signal, condition).then(
      (still) => {
        const target = canvas.current;
        if (abort.signal.aborted || !target) return;
        target.width = still.width;
        target.height = still.height;
        target.getContext('2d')?.drawImage(still, 0, 0);
      },
      () => {
        if (!abort.signal.aborted) onFail();
      },
    );
    return () => abort.abort();
  }, [presentation, id, condition]);
  return (
    <canvas
      ref={canvas}
      className="item-art__still"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ '--art-size': `${size}px` } as CSSProperties}
    />
  );
}

function LiveItem({
  presentation,
  id,
  size,
  condition,
  onFail,
}: {
  readonly presentation: ItemPresentation;
  readonly id: string;
  readonly size: number;
  readonly condition?: ItemState;
  readonly onFail: () => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    view = useRef<ItemInspection>(undefined);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    const inspection = (view.current = presentation.inspect(host.current!, id, {
      condition,
      onReady: () => setReady(true),
    }));
    return () => {
      inspection.dispose();
      view.current = undefined;
    };
  }, [presentation, id, condition]);
  return (
    <div className="item-art item-art--live" data-ready={ready || undefined}>
      <ItemStill
        presentation={presentation}
        id={id}
        size={size}
        condition={condition}
        onFail={onFail}
      />
      <div ref={host} className="item-art__viewer" />
      <button
        type="button"
        className="item-art__reset"
        disabled={!ready}
        onClick={() => view.current?.reset()}
      >
        Вернуть вид
      </button>
      <p className="item-art__hint" aria-hidden="true">
        Поверните предмет пальцем или мышью
      </p>
    </div>
  );
}
