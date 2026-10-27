import { ACESFilmicToneMapping, AnimationMixer, Box3, Clock } from 'three';
import {
  BlockView,
  type GraphicsMode,
  type Guest,
  type GuestWorld,
  type Stage,
  type StageBuilder,
} from '../../packages/blockworld/src/index.ts';
import { NO_CHEST, type ChestHandles } from '../application/ports/chest-handles.ts';
import { ENDER_CASE } from '../config/cases.ts';
import { CHEST_WIDTH } from '../adapters/outbound/chest/chest-bounds.ts';
import { chestEffectColor } from '../adapters/outbound/chest/chest-appearance.ts';
import { loadChestAssets, type ChestAssets } from '../adapters/outbound/chest/chest-assets.ts';
import { OVERWORLD_BLOCKS } from '../adapters/outbound/worlds/overworld-blocks.ts';

type LabSettings = {
  seed: number;
  scale: number;
  fov: number;
  warmth: number;
  fog: number;
  cameraX: number;
  cameraY: number;
  targetX: number;
  targetY: number;
  targetZ: number;
};
const defaults: LabSettings = {
  seed: 11,
  scale: 1,
  fov: 54,
  warmth: 0.86,
  fog: 150,
  cameraX: 0,
  cameraY: 0,
  targetX: 0,
  targetY: 0,
  targetZ: 0,
};
const storageKey = 'voxel-vault-rendering-poc:v1';
const settings = { ...defaults, ...loadSettings() };
const host = document.querySelector<HTMLElement>('#scene')!;
let view: BlockView<ChestHandles> | undefined;
let guest: Guest | undefined;
let chestAssets: ChestAssets | undefined;
let chestAnimation: AnimationMixer | undefined;
let chestClock: Clock | undefined;
let chestWorld: GuestWorld | undefined;
let chestFrame = 0;
let revision = 0;
let rebuildTimer = 0;
let graphicsMode: GraphicsMode = 'baseline';

function buildView(): void {
  view?.dispose();
  const builder: StageBuilder<ChestHandles> = {
    id: `rendering-poc-overworld-${++revision}`,
    build(seed): Stage<ChestHandles> {
      const stage = OVERWORLD_BLOCKS.build(seed);
      const target: readonly [number, number, number] = [
        stage.camera.target[0] + settings.targetX,
        stage.camera.target[1] + settings.targetY,
        stage.camera.target[2] + settings.targetZ,
      ];
      const origin = stage.camera.position;
      const dx = origin[0] - target[0],
        dy = origin[1] - target[1],
        dz = origin[2] - target[2];
      return {
        ...stage,
        camera: {
          ...stage.camera,
          position: [
            target[0] + dx * settings.scale + settings.cameraX,
            target[1] + dy * settings.scale + settings.cameraY,
            target[2] + dz * settings.scale,
          ],
          fov: settings.fov,
          drift: 0,
        },
        sky: stage.sky,
        fog: { ...stage.fog, far: settings.fog },
        sun: stage.sun ? { ...stage.sun, color: warmthColor(settings.warmth) } : undefined,
      };
    },
  };
  view = new BlockView(host, builder, { seed: settings.seed, graphicsMode });
  view.hold(NO_CHEST);
  if (guest) view.admit(guest);
}

function warmthColor(amount: number): string {
  const a = Math.max(0, Math.min(1, amount));
  const [r, g, b] = [255, Math.round(176 + a * 50), Math.round(129 + a * 75)];
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function loadSettings(): Partial<LabSettings> {
  try {
    return JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<LabSettings>;
  } catch {
    return {};
  }
}

async function loadChest(): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(new Error('Chest model load timed out after 30 seconds.')),
    30_000,
  );
  try {
    chestAssets = await loadChestAssets(
      new URL('/', window.location.href),
      controller.signal,
      ENDER_CASE.model,
      ENDER_CASE.appearance,
      chestEffectColor(ENDER_CASE.appearance),
    );
  } finally {
    window.clearTimeout(timeout);
  }
  const root = chestAssets.visual;
  root.position.y = -new Box3().setFromObject(root).min.y;
  chestAnimation = new AnimationMixer(chestAssets.animationRoot);
  const clip = chestAssets.animations[0];
  if (clip) chestAnimation.clipAction(clip).play().paused = true;
  chestClock = new Clock();
  guest = {
    // Keep the current production chest model and scale in both A/B render modes.
    root,
    unit: CHEST_WIDTH / 1.15,
    front: [-5, -7],
    look: {
      toneMapping: ACESFilmicToneMapping,
      exposure: 1.1,
      srgb: true,
      shadows: true,
      clipping: true,
    },
    enter(world) {
      chestWorld = world;
      chestClock?.start();
      chestFrame = requestAnimationFrame(animateChest);
    },
    leave() {
      chestWorld = undefined;
      cancelAnimationFrame(chestFrame);
    },
  };
  view?.admit(guest);
  document.querySelector('#loading')!.classList.add('done');
  document.querySelector('#credit')!.textContent = 'Voxel Vault · scene study';
}

function animateChest(): void {
  if (!chestWorld) return;
  chestAnimation?.update(Math.min(chestClock?.getDelta() ?? 0, 0.05));
  chestWorld.draw();
  chestFrame = requestAnimationFrame(animateChest);
}

const fields: [keyof LabSettings, string, number, number, number][] = [
  ['seed', 'Вариант листвы', 1, 100, 1],
  ['scale', 'Масштаб обзора', 1, 2.7, 0.01],
  ['fov', 'Угол камеры', 35, 70, 0.1],
  ['warmth', 'Теплота солнца', 0, 1, 0.01],
  ['fog', 'Дальность тумана', 120, 500, 1],
  ['cameraX', 'Смещение камеры X', -12, 12, 0.1],
  ['cameraY', 'Высота камеры', -6, 12, 0.1],
  ['targetX', 'Точка взгляда X', -12, 12, 0.1],
  ['targetY', 'Точка взгляда Y', -8, 16, 0.1],
  ['targetZ', 'Точка взгляда Z', -24, 24, 0.1],
];

const controls = document.querySelector<HTMLElement>('#controls')!;
for (const [key, title, min, max, step] of fields) {
  const row = document.createElement('div');
  row.className = 'control';
  const label = document.createElement('label'),
    name = document.createElement('span'),
    output = document.createElement('output');
  const input = document.createElement('input');
  name.textContent = title;
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(settings[key]);
  const updateOutput = () => {
    output.textContent = key === 'seed' ? String(settings[key]) : Number(settings[key]).toFixed(2);
  };
  updateOutput();
  label.append(name, output);
  row.append(label, input);
  controls.append(row);
  input.addEventListener('input', () => {
    settings[key] = Number(input.value);
    updateOutput();
    localStorage.setItem(storageKey, JSON.stringify(settings));
    window.clearTimeout(rebuildTimer);
    rebuildTimer = window.setTimeout(buildView, 180);
  });
}

document.querySelector<HTMLButtonElement>('#reset')!.addEventListener('click', () => {
  Object.assign(settings, defaults);
  localStorage.removeItem(storageKey);
  controls.querySelectorAll<HTMLInputElement>('input').forEach((input, index) => {
    const [key] = fields[index]!;
    input.value = String(settings[key]);
    input.parentElement!.querySelector('output')!.textContent =
      key === 'seed' ? String(settings[key]) : Number(settings[key]).toFixed(2);
  });
  buildView();
});

document.querySelector<HTMLButtonElement>('#shot')!.addEventListener('click', () => {
  if (!view) return;
  const link = document.createElement('a');
  link.download = 'overworld-blockworld-lab.png';
  link.href = view.snapshot('image/png');
  link.click();
});
const graphicsButton = document.querySelector<HTMLButtonElement>('#graphics-mode')!;
const updateGraphicsButton = () => {
  graphicsButton.textContent =
    graphicsMode === 'baseline' ? 'Рендер: исходный' : 'Рендер: PoC-тени';
};
updateGraphicsButton();
graphicsButton.addEventListener('click', () => {
  graphicsMode = graphicsMode === 'baseline' ? 'shadow-poc' : 'baseline';
  view?.setGraphicsMode(graphicsMode);
  updateGraphicsButton();
});
const metricsNode = document.querySelector<HTMLElement>('#metrics')!;
window.setInterval(() => {
  const m = view?.renderMetrics;
  if (!m) return;
  metricsNode.textContent = `${m.mode === 'baseline' ? 'BASELINE' : 'SHADOW PoC'} · ${m.fps.toFixed(1)} fps · ${m.frameMs.toFixed(2)} ms avg CPU · ${m.drawCalls} calls · ${(m.triangles / 1000).toFixed(1)}k tris · ${m.geometries} geo / ${m.textures} tex · shadow ${m.shadowMap ? 'on' : 'off'}`;
}, 400);
const panel = document.querySelector<HTMLElement>('#panel')!;
const togglePanel = () => {
  panel.classList.toggle('hidden');
  document.querySelector('#toggle')!.textContent = panel.classList.contains('hidden')
    ? 'Показать панель'
    : 'Скрыть панель';
};
document.querySelector('#toggle')!.addEventListener('click', togglePanel);
window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'h' && !(event.target instanceof HTMLInputElement)) togglePanel();
});
window.addEventListener(
  'pagehide',
  () => {
    view?.dispose();
    chestAssets?.dispose();
  },
  { once: true },
);
const loading = document.querySelector<HTMLElement>('#loading')!;
const credit = document.querySelector<HTMLElement>('#credit')!;
loading.textContent = 'Строю voxel-сцену…';
window.setTimeout(() => {
  try {
    buildView();
    // Let the scene show while the separate chest asset finishes loading.
    loading.classList.add('done');
    credit.textContent = 'Сцена готова · загружаю сундук…';
    void loadChest().catch((error) => {
      console.error('Could not load the chest model for the scene lab.', error);
      credit.textContent = 'Сцена готова · модель сундука не загрузилась';
    });
  } catch (error) {
    console.error('Could not build the blockworld scene.', error);
    loading.textContent = `Не удалось построить voxel-сцену: ${error instanceof Error ? error.message : String(error)}`;
  }
}, 0);
