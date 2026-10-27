import { useEffect, useRef, useState } from 'react';
import type { CaseDefinition } from '../../../config/cases.ts';
import type { ChestAppearance } from '../../../domain/chest-appearance.ts';
import type { ChestPreviewRenderer } from '../../outbound/chest/chest-preview-renderer.ts';

export function ChestThumbnail({
  renderer,
  definition,
  appearance,
}: {
  readonly renderer: Pick<ChestPreviewRenderer, 'render'>;
  readonly definition: CaseDefinition;
  readonly appearance: ChestAppearance;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setFailed(false);
    void renderer
      .render(definition, appearance, abort.signal)
      .then((image) => {
        if (abort.signal.aborted || !canvas.current) return;
        const target = canvas.current;
        target.width = image.width;
        target.height = image.height;
        target.getContext('2d')?.drawImage(image, 0, 0);
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => abort.abort();
  }, [renderer, definition, appearance]);
  return (
    <div className="inventory-card__preview">
      {failed ? (
        <span className="inventory-card__preview-error">Превью недоступно</span>
      ) : (
        <canvas ref={canvas} width="640" height="520" aria-hidden="true" />
      )}
    </div>
  );
}
