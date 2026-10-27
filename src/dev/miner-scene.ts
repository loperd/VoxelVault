import { ACESFilmicToneMapping, Box3 } from 'three';
import { BlockView } from '../../packages/blockworld/src/index.ts';
import { MINER_BLOCKOUT } from '../adapters/outbound/worlds/miner/blockout.ts';
import { MINER_VAULT } from '../adapters/outbound/worlds/miner/index.ts';
import { NO_CHEST, type ChestHandles } from '../application/ports/chest-handles.ts';
import { CASES } from '../config/cases.ts';
import { CHEST_WIDTH } from '../adapters/outbound/chest/chest-bounds.ts';
import { loadChestAssets, type ChestAssets } from '../adapters/outbound/chest/chest-assets.ts';
import { chestEffectColor } from '../adapters/outbound/chest/chest-appearance.ts';

const params = new URLSearchParams(location.search);
const blockout = params.get('phase') !== 'previous';
const view = new BlockView<ChestHandles>(
  document.querySelector<HTMLElement>('#scene')!,
  blockout ? MINER_BLOCKOUT : MINER_VAULT,
  { seed: 11 },
);
view.hold(NO_CHEST);
const status = document.querySelector<HTMLElement>('#status')!;
const controller = new AbortController();
let assets: ChestAssets | undefined;
let disposed = false;
const timeout = window.setTimeout(() => controller.abort(), 30_000);
const definition = CASES.find((c) => c.id === 'deep-mine')!;
status.textContent = blockout
  ? 'Архитектурный blockout · этап 1 · ожидает визуальной проверки'
  : 'Предыдущая версия · сравнение';
if (!blockout && params.has('chest'))
  void loadChestAssets(
    new URL('/', location.href),
    controller.signal,
    definition.model,
    definition.appearance,
    chestEffectColor(definition.appearance),
  )
    .then((loaded) => {
      if (disposed) {
        loaded.dispose();
        return;
      }
      assets = loaded;
      loaded.visual.position.y = -new Box3().setFromObject(loaded.visual).min.y;
      view.admit({
        root: loaded.visual,
        unit: CHEST_WIDTH / 1.15,
        front: [0, 1],
        look: { toneMapping: ACESFilmicToneMapping, exposure: 1.1, srgb: true, shadows: true },
      });
      status.textContent = 'Кладовая Шахтёра';
    })
    .catch((error) => {
      if (!disposed) {
        status.textContent = 'Шахта готова · модель сундука недоступна';
        console.error(error);
      }
    })
    .finally(() => window.clearTimeout(timeout));
Object.assign(window, {
  minerReview: {
    phase: blockout ? 'blockout' : 'previous',
    metrics: () => view.renderMetrics,
    renderAt: (seconds: number) => view.renderAt(seconds),
    snapshot: () => view.snapshot('image/png', 1, { guests: false }),
  },
});
if (blockout || !params.has('chest')) window.clearTimeout(timeout);
window.addEventListener(
  'pagehide',
  () => {
    disposed = true;
    controller.abort();
    window.clearTimeout(timeout);
    view.dispose();
    assets?.dispose();
  },
  { once: true },
);
