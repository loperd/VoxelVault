import {
  ACESFilmicToneMapping,
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  PerspectiveCamera,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  BlockView,
  guestKey,
  loadPackAssets,
  packDiagnostics,
  packFilesAt,
  packStage,
  readWorldPack,
  type GraphicsMode,
  type PackAssets,
  type StageBuilder,
} from '../../packages/blockworld/src/index.ts';
import { NO_CHEST, type ChestHandles } from '../application/ports/chest-handles.ts';
import { BLOCK_WORLDS } from '../adapters/outbound/worlds/index.ts';
import { MINER_CONCEPTS } from '../adapters/outbound/worlds/miner-concepts/index.ts';
import { VEIL } from '../adapters/inbound/react/PixelWorldBackground.tsx';
import { CASES } from '../config/cases.ts';
import { CHEST_WIDTH } from '../adapters/outbound/chest/chest-bounds.ts';
import { loadChestAssets } from '../adapters/outbound/chest/chest-assets.ts';
import { chestEffectColor } from '../adapters/outbound/chest/chest-appearance.ts';
import { ART_LAB } from '../adapters/outbound/worlds/art-lab/index.ts';

/**
 * One block world, one still frame, for before/after review: the game's BlockView and stage, at a
 * fixed 1600×900 and time, so two captures differ only by the change under review.
 * ?world=deep-mine (any BLOCK_WORLDS id, or concept-sinkhole / concept-gallery / concept-geode) ·
 * &mode=shadow-poc · &veil (the game's interface veil) · &t=0 · &chest=<case id> (that case's chest on
 * the anchor, as the game stands it; the frame waits for it).
 * &orbit: the whole window, live, the camera turned with the mouse (drag), wheel to come closer,
 * right drag to move; a list of the worlds in the corner. Starts from the stage's own camera.
 * ?pack=<folder under /packs/> instead of ?world: a world pack, read and loaded as any pack is (no
 * code knows which) · &camera=<name> (default the first) · &anchor=<marker> (where a chest stands;
 * default the first marker tagged "guest") · &views=2: two views of one PackAssets side by side ·
 * &close=1: the first of them disposed before the frame (the second must go on).
 * Result: window.review.snapshot() → PNG data URL, window.review.metrics(), window.review.pack
 * (diagnostics, and cycles(n): n loads and releases of the pack, the counts after each).
 */
const params = new URLSearchParams(location.search);
const stages: Record<string, StageBuilder<ChestHandles> | undefined> = {
  ...BLOCK_WORLDS,
  ...MINER_CONCEPTS,
  ...ART_LAB,
};
const host = document.querySelector<HTMLElement>('#scene')!;
const orbit = params.has('orbit');
if (orbit) Object.assign(host.style, { width: '100vw', height: '100vh' });
const options = {
  seed: 11,
  graphicsMode: (params.get('mode') ?? 'baseline') as GraphicsMode,
  ...(params.has('veil') ? { veil: VEIL } : {}),
};
const packName = params.get('pack');
const id = params.get('world') ?? 'deep-mine';
let builder: StageBuilder<ChestHandles> | undefined,
  pack: { assets: PackAssets; views: BlockView<ChestHandles>[] } | undefined;
if (packName) {
  const assets = await openPack(packName, new AbortController().signal);
  const camera = params.get('camera') ?? [...assets.pack.cameras.keys()][0]!;
  const anchor =
    params.get('anchor') ??
    [...assets.pack.markers.values()].find((marker) => marker.tags.includes('guest'))?.name;
  builder = packStage<ChestHandles>(assets, { camera, ...(anchor ? { anchor } : {}) });
  pack = { assets, views: [] };
} else {
  builder = stages[id];
  if (!builder) throw new Error(`Unknown world "${id}": ${Object.keys(stages).join(', ')}`);
}
let view: BlockView<ChestHandles>;
if (pack && params.get('views') === '2') {
  // Two views of one pack, each its own stage; the chest goes to the second.
  Object.assign(host.style, { display: 'grid', gridTemplateColumns: '1fr 1fr' });
  const halves = [0, 1].map(() =>
    host.appendChild(
      Object.assign(document.createElement('div'), {
        style: 'position:relative;height:100%;overflow:hidden',
      }),
    ),
  );
  pack.views = halves.map((half) => new BlockView<ChestHandles>(half, builder, options));
  if (params.get('close') === '1') {
    pack.views[0]!.dispose();
    halves[0]!.style.background = '#200';
  }
  view = pack.views[1]!;
} else {
  view = new BlockView<ChestHandles>(host, builder, options);
  if (pack) pack.views = [view];
}
view.hold(NO_CHEST);

/** A pack from /packs/<name>/: read, checked, loaded; on any failure nothing of it stays. */
async function openPack(name: string, signal: AbortSignal): Promise<PackAssets> {
  const read = await readWorldPack(
    packFilesAt(new URL(`/packs/${encodeURIComponent(name)}/`, location.href)),
    { signal },
  );
  for (const warning of read.warnings) console.warn(warning);
  return loadPackAssets(read, { signal });
}
const chest = params.get('chest');
if (chest) {
  const definition = CASES.find((c) => c.id === chest);
  if (!definition) throw new Error(`Unknown case "${chest}": ${CASES.map((c) => c.id).join(', ')}`);
  const loaded = await loadChestAssets(
    new URL('/', location.href),
    new AbortController().signal,
    definition.model,
    definition.appearance,
    chestEffectColor(definition.appearance),
  );
  loaded.visual.position.y = -new Box3().setFromObject(loaded.visual).min.y;
  // Lit the way the game's chest scene lights it (three-chest-drop-scene.ts, lightBy): the world's sky
  // and ground, and a key light — from where the world says its key is, as strong as it says.
  const root = new Group(),
    sky = new HemisphereLight(0xffffff, 0x435846, 2),
    key = new DirectionalLight(0xffffff, 3);
  key.position.set(3, 6, -4);
  root.add(loaded.visual, sky, key, key.target);
  view.admit({
    root,
    unit: CHEST_WIDTH / 1.15,
    front: [0, 1],
    look: { toneMapping: ACESFilmicToneMapping, exposure: 1.1, srgb: true, shadows: true },
    enter(world) {
      sky.color.set(world.light?.sky ?? 0xffffff);
      sky.groundColor.set(world.light?.ground ?? 0x435846);
      key.color.set(world.light?.key ?? 0xffffff);
      key.position.set(...(guestKey(world, Math.hypot(3, 6, -4)) ?? [3, 6, -4]));
      key.intensity = world.light?.keyStrength ?? 3;
      sky.intensity = world.light?.fillStrength ?? 2;
      world.draw();
    },
  });
}
view.renderAt(Number(params.get('t') ?? 0));
for (const other of pack?.views ?? [])
  if (other !== view) other.renderAt(Number(params.get('t') ?? 0));
Object.assign(window, {
  review: {
    snapshot: () =>
      pack && pack.views.length > 1 ? sideBySide(pack.views) : view.snapshot('image/png', 1),
    metrics: () => view.renderMetrics,
    pack: pack && {
      diagnostics: () => ({ ...packDiagnostics, instances: pack!.assets.instances }),
      /** n loads, each shown in a view, drawn, then the view disposed and the resources released. */
      async cycles(n: number) {
        const counts = [];
        for (let i = 0; i < n; i++) {
          const assets = await openPack(packName!, new AbortController().signal),
            element = document.body.appendChild(document.createElement('div'));
          Object.assign(element.style, {
            position: 'fixed',
            width: '320px',
            height: '180px',
            left: '-400px',
          });
          const shown = new BlockView<ChestHandles>(
            element,
            packStage(assets, { camera: [...assets.pack.cameras.keys()][0]! }),
            { seed: 1 },
          );
          shown.renderAt(0);
          const memory = shown.renderMetrics;
          shown.dispose();
          assets.release();
          element.remove();
          counts.push({
            ...packDiagnostics,
            geometries: memory.geometries,
            textures: memory.textures,
          });
        }
        return counts;
      },
    },
  },
});

/** The views' pictures side by side, as one PNG (a disposed view shows as a dark half). */
function sideBySide(views: readonly BlockView<ChestHandles>[]): Promise<string> {
  const canvas = Object.assign(document.createElement('canvas'), { width: 1600, height: 900 }),
    g = canvas.getContext('2d')!;
  g.fillStyle = '#200';
  g.fillRect(0, 0, 1600, 900);
  return Promise.all(
    views.map(
      (shown, i) =>
        new Promise<void>((resolve) => {
          if (!shown.canvas.isConnected) {
            resolve();
            return;
          }
          const image = new Image();
          image.onload = () => {
            g.drawImage(image, i * 800, 0, 800, 900);
            resolve();
          };
          image.src = shown.snapshot('image/png', 1);
        }),
    ),
  ).then(() => canvas.toDataURL('image/png'));
}

if (orbit) {
  // The controls turn a stand-in camera; the world's own camera follows it.
  const home = view.home,
    stand = new PerspectiveCamera();
  stand.position.set(...home.position);
  const controls = new OrbitControls(stand, view.canvas);
  controls.target.set(...home.target);
  controls.enableDamping = true;
  controls.update();
  const follow = () => view.aim(stand.position.toArray(), controls.target.toArray());
  controls.addEventListener('change', follow);
  follow();
  const tick = () => {
    controls.update();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const menu = document.createElement('nav');
  menu.style.cssText =
    'position:fixed;top:12px;left:12px;z-index:2;display:flex;gap:6px;flex-wrap:wrap;font:13px system-ui';
  for (const world of Object.keys(stages)) {
    const link = Object.assign(document.createElement('a'), {
      textContent: world,
      href: `?world=${world}&orbit${chest ? `&chest=${chest}` : ''}`,
    });
    link.style.cssText = `padding:4px 8px;border-radius:6px;color:#fff;text-decoration:none;background:${world === id ? '#6a4fc4' : '#0009'}`;
    menu.append(link);
  }
  document.body.append(menu);
}
