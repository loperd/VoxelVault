import {
  LIGHTING_PRESETS,
  loadPackAssets,
  packFilesAt,
  packStage,
  presetOf,
  readWorldPack,
  type LightingPreset,
  type PackAssets,
  type PackFiles,
  type StageBuilder,
} from '../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../application/ports/chest-handles.ts';

/** The light a pack opens in: its default preset if it names one, else its `environment`. */
export const PACK_LIGHT = 'pack';

/** A pack loaded for one view: its resources (released by whoever loaded them) and its stage. */
export interface PackWorld {
  readonly assets: PackAssets;
  readonly stage: StageBuilder<ChestHandles>;
  /** What the player may light it with: the pack's own light (the one it opens in), the library's presets, the pack's. */
  readonly lighting: readonly { readonly name: string; readonly label: string }[];
  /** A choice of `lighting` as `BlockView.setLighting` takes it. */
  preset(name: string): LightingPreset | undefined;
}

/**
 * Reads and loads a pack (all or nothing; on `signal` it rejects and keeps nothing) and stages it
 * from its first camera, the chest on its first marker tagged `guest`.
 */
export async function loadPackWorld(
  id: string,
  options: { readonly signal: AbortSignal; readonly files?: PackFiles },
): Promise<PackWorld> {
  const { signal } = options;
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  const pack = await readWorldPack(
    options.files ??
      packFilesAt(new URL(`${base}packs/${encodeURIComponent(id)}/`, document.baseURI)),
    { signal },
  );
  const camera = pack.cameras.keys().next().value;
  const anchor = [...pack.markers.values()].find((marker) => marker.tags.includes('guest'))?.name;
  if (camera === undefined || anchor === undefined)
    throw new Error(
      `The pack "${pack.id}" takes no chest: it needs a camera and a marker tagged "guest".`,
    );
  // The pack's own presets after the library's; one of the same name stands in its place.
  const named = new Map<string, LightingPreset>([
    ...Object.entries(LIGHTING_PRESETS),
    ...(pack.lighting?.presets ?? []),
  ]);
  const assets = await loadPackAssets(pack, { signal });
  try {
    return {
      assets,
      stage: packStage<ChestHandles>(assets, { camera, anchor }),
      lighting: [
        { name: PACK_LIGHT, label: 'Свет пака' },
        ...[...named].map(([name, preset]) => ({ name, label: preset.label })),
      ],
      // Back to the pack's light is back to how it opened, its default preset included.
      preset: (name) =>
        name !== PACK_LIGHT
          ? presetOf(pack, name)
          : pack.lighting?.default
            ? presetOf(pack, pack.lighting.default)
            : undefined,
    };
  } catch (error) {
    assets.release();
    throw error;
  }
}
