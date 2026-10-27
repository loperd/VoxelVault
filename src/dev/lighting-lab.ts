import { Light, PerspectiveCamera, Vector3 } from 'three';
import {
  BlockView,
  LIGHTING_PRESETS,
  LightingError,
  LOCAL_TYPES,
  loadPackAssets,
  packDiagnostics,
  packFilesAt,
  packStage,
  presetOf,
  readLightingPreset,
  readWorldPack,
  type Guest,
  type LightingPreset,
  type PackAssets,
} from '../../packages/blockworld/src/index.ts';
import { NO_CHEST, type ChestHandles } from '../application/ports/chest-handles.ts';
import { CASES } from '../config/cases.ts';
import { NO_BREAKAGE } from '../domain/chest-breakage.ts';
import { ThreeChestDropScene } from '../adapters/outbound/chest/three-chest-drop-scene.ts';
import { presetJson } from './lighting-json.ts';

/**
 * Lighting Lab: one world pack, one camera, its light changed by presets. Dev only.
 * ?pack=<folder under /packs/> (required) · &camera · &anchor (default the first marker
 * tagged "guest") · &chest=<case id> (the game's own chest scene on the anchor, held as on the case
 * screen, lit by the world as in the game) ·
 * &preset=<name> (library or the pack's) · &grid (four views side by side, one camera, the four
 * library presets or &presets=a,b,c,d) · &capture (no panel; for scripts/lighting-lab.mjs).
 * The panel: choose a preset, change what it supports and see it at once, Reset, Export JSON
 * (a change of the chosen preset, `{ "base": … }`), Load JSON (a file of yours, no code). A preset
 * that does not read says every problem and the light stays as it was.
 * window.lab: apply(json) → { ms }, snapshot() → PNG, stats() → what the picture shows, metrics(),
 * state() → the preset shown and the panel's problems, alive() → what of the pack is alive,
 * close() → what is left alive after all is freed.
 */
const params = new URLSearchParams(location.search);
const host = document.querySelector<HTMLElement>('#scene')!;
const packName = params.get('pack');
// The page names no pack: which one is shown is the URL's.
if (!packName) {
  host.textContent = 'Which pack? Add ?pack=<folder under /packs/>.';
  throw new Error('No ?pack given.');
}
const capture = params.has('capture');

const read = await readWorldPack(
  packFilesAt(new URL(`/packs/${encodeURIComponent(packName)}/`, location.href)),
  { signal: new AbortController().signal },
);
const assets: PackAssets = await loadPackAssets(read, { signal: new AbortController().signal });
const pack = assets.pack;
let cameraName = params.get('camera') ?? [...pack.cameras.keys()][0]!;
const anchor =
  params.get('anchor') ??
  [...pack.markers.values()].find((marker) => marker.tags.includes('guest'))?.name;
const stageFor = (camera: string) =>
  packStage<ChestHandles>(assets, { camera, ...(anchor ? { anchor } : {}) });
const builder = stageFor(cameraName);
/** Every preset this pack can show: the library's, then its own. */
const named = (): Record<string, LightingPreset> => ({
  ...LIGHTING_PRESETS,
  ...Object.fromEntries(pack.lighting?.presets ?? []),
});

// ── Views ─────────────────────────────────────────────────────────────────────────────────────

const grid = params.has('grid');
const gridPresets = (
  params.get('presets')?.split(',') ?? [
    'warm-torchlit',
    'cold-moonlight',
    'golden-hour',
    'dark-cinematic',
  ]
).slice(0, 4);
const cells = grid
  ? gridPresets.map(() =>
      host.appendChild(Object.assign(document.createElement('div'), { className: 'cell' })),
    )
  : [host];
if (grid) host.classList.add('grid');
const views = cells.map((cell) => new BlockView<ChestHandles>(cell, builder, { seed: 11 }));
for (const view of views) view.hold(NO_CHEST);
let view = views[0]!;
if (grid)
  gridPresets.forEach((name, i) => {
    views[i]!.setLighting(presetOf(pack, name));
    cells[i]!.append(
      Object.assign(document.createElement('span'), {
        className: 'label',
        textContent: named()[name]?.label ?? name,
      }),
    );
  });

const chest = params.get('chest');
/** The game's chest scene, its guest as a view takes it in (the scene's own, told when the chest stands in a world). */
interface Chest {
  readonly scene: ThreeChestDropScene;
  readonly guest: Guest;
  entered(): Promise<void>;
}
/** The game's chest scenes, one per view (a guest stands in one world). */
const chests: Chest[] = chest
  ? await Promise.all(views.map((shown) => admitChest(shown, chest)))
  : [];

/** The case's chest as the game makes it (main.tsx): its scene's guest and handles in the view, held in the air as on the case screen. */
async function admitChest(shown: BlockView<ChestHandles>, id: string): Promise<Chest> {
  const definition = CASES.find((c) => c.id === id);
  if (!definition) throw new Error(`Unknown case "${id}": ${CASES.map((c) => c.id).join(', ')}`);
  const scene = new ThreeChestDropScene(
    new URL('/', location.href),
    document,
    definition.model,
    definition.appearance,
    undefined,
    NO_BREAKAGE,
    Number.parseInt(definition.presentation.theme.accent.slice(1), 16),
  );
  // The scene enters a world once its physics is ready; a task later it has stood in it and lit itself.
  let arrival = Promise.resolve();
  const guest: Guest = {
    ...scene.guest,
    enter(world) {
      arrival = new Promise((done) => {
        world.physics.then(
          () => setTimeout(done),
          () => setTimeout(done),
        );
      });
      scene.guest.enter?.(world);
    },
  };
  shown.hold(scene.handles);
  shown.admit(guest);
  const signal = new AbortController().signal;
  await scene.prepare(signal);
  await scene.preview(signal);
  return { scene, guest, entered: () => arrival };
}

// ── The preset being edited ───────────────────────────────────────────────────────────────────

let base: string | undefined = params.get('preset') ?? pack.lighting?.default ?? undefined;
let current: LightingPreset | undefined = base ? presetOf(pack, base) : undefined;
let lastMs = 0;
const apply = (preset: LightingPreset | undefined): number => {
  const started = performance.now();
  if (!grid) view.setLighting(preset);
  current = preset;
  lastMs = performance.now() - started;
  return lastMs;
};
if (current && !grid) apply(current);
for (const shown of views) shown.renderAt(0);

/** What a picture shows, for judging light: brightness, crushed blacks, clipped whites, warmth, the main object against the frame. */
function stats(canvas: HTMLCanvasElement, focus: readonly [number, number]) {
  const g = Object.assign(document.createElement('canvas'), {
    width: canvas.width,
    height: canvas.height,
  }).getContext('2d', { willReadFrequently: true })!;
  g.drawImage(canvas, 0, 0);
  const { data, width, height } = g.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0,
    black = 0,
    white = 0,
    r = 0,
    gr = 0,
    b = 0,
    inSum = 0,
    inSq = 0,
    inCount = 0;
  const [fx, fy] = [focus[0] * width, focus[1] * height],
    hw = width * 0.1,
    hh = height * 0.14;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4,
        lum = (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255;
      sum += lum;
      r += data[i]!;
      gr += data[i + 1]!;
      b += data[i + 2]!;
      if (lum < 0.02) black++;
      if (lum > 0.98) white++;
      if (Math.abs(x - fx) < hw && Math.abs(y - fy) < hh) {
        inSum += lum;
        inSq += lum * lum;
        inCount++;
      }
    }
  const n = width * height,
    focusMean = inSum / inCount;
  return {
    meanLuminance: +(sum / n).toFixed(4),
    crushedBlack: +(black / n).toFixed(4),
    clippedWhite: +(white / n).toFixed(4),
    rgb: [r, gr, b].map((v) => +(v / n / 255).toFixed(4)),
    warmth: +(r / Math.max(1, b)).toFixed(3),
    focusLuminance: +focusMean.toFixed(4),
    focusContrast: +Math.sqrt(Math.max(0, inSq / inCount - focusMean * focusMean)).toFixed(4),
    focusToFrame: +(focusMean / Math.max(1e-4, sum / n)).toFixed(3),
  };
}

let focus = pack.cameras.get(cameraName)!.focus ?? [0.5, 0.5];

/**
 * Another of the pack's cameras, as the game changes worlds (PixelWorldBackground): the chest leaves
 * the old view, the view is closed, a new one takes the chest in, in the light shown. One view only.
 */
async function switchCamera(name: string): Promise<void> {
  if (grid) throw new Error('The four-preset grid keeps one camera.');
  if (!pack.cameras.has(name))
    throw new Error(`No camera "${name}" (there are ${[...pack.cameras.keys()].join(', ')}).`);
  const held = chests[0];
  if (held) view.dismiss(held.guest);
  view.dispose();
  cameraName = name;
  focus = pack.cameras.get(name)!.focus ?? [0.5, 0.5];
  view = views[0] = new BlockView<ChestHandles>(host, stageFor(name), { seed: 11 });
  view.hold(held?.scene.handles ?? NO_CHEST);
  if (current) view.setLighting(current);
  if (held) {
    view.admit(held.guest);
    await held.entered();
    await held.scene.preview(new AbortController().signal);
  }
  view.renderAt(0);
}
Object.assign(window, {
  lab: {
    presets: () => Object.keys(named()),
    /** The preset shown (null: the pack's own light) and the problems the panel shows. */
    state: () => ({
      name: current?.name ?? null,
      preset: current ?? null,
      problems: [...document.querySelectorAll('.panel .problems li')].map((li) => li.textContent),
    }),
    /** Every light in each chest's things, as the chest scene set them: a relight must change these, never add to them. */
    chestLights: () =>
      chests.map(({ scene }) => {
        const found: {
          uuid: string;
          type: string;
          color: string;
          intensity: number;
          position: number[];
        }[] = [];
        scene.guest.root.traverse((object) => {
          if (object instanceof Light)
            found.push({
              uuid: object.uuid,
              type: object.type,
              color: object.color.getHexString(),
              intensity: +object.intensity.toFixed(4),
              position: object.position.toArray().map((v) => +v.toFixed(3)),
            });
        });
        return found;
      }),
    /** Everything freed — chests, views, the pack's resources — and what of a pack is still alive (all 0). */
    close() {
      for (const shown of views) shown.dispose();
      for (const { scene } of chests) scene.dispose();
      assets.release();
      return {
        assets: packDiagnostics.assets,
        resources: packDiagnostics.resources,
        instances: assets.instances,
      };
    },
    /** What of the pack is alive now (counts; close() frees it all). */
    alive: () => ({
      assets: packDiagnostics.assets,
      resources: packDiagnostics.resources,
      instances: assets.instances,
    }),
    /** Another of the pack's cameras (one view): resolves once the chest stands in the new view. */
    camera: (name: string) => switchCamera(name),
    /** A preset as JSON (complete or `{ base, … }`), or a name; null for the pack's own light. */
    apply(json: unknown) {
      const preset =
        json === null
          ? undefined
          : typeof json === 'string'
            ? presetOf(pack, json)
            : readLightingPreset(json, (name) => named()[name]);
      const ms = apply(preset),
        started = performance.now(),
        gl = view.canvas.getContext('webgl2')!;
      // The first frame, waited for: the new meshes uploaded and drawn (a pixel read back waits for the GPU).
      view.renderAt(0);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      return { ms, firstFrameMs: performance.now() - started, name: preset?.name ?? null };
    },
    snapshot: () => view.snapshot('image/png', 1),
    stats: () => stats(view.canvas, focus),
    metrics: () => ({ ...view.renderMetrics, relightMs: lastMs }),
    /** n frames drawn one after another: the average CPU time of one (GPU work is not timed by WebGL). */
    frameMs(n = 30) {
      const started = performance.now();
      for (let i = 0; i < n; i++) view.renderAt(1 / 30);
      return (performance.now() - started) / n;
    },
    /** The grid's pictures as one PNG. */
    sheet: () => sheet(),
    /** What stays fixed between the pictures: the camera, the canvas, the clock, the guest's look, the GPU. */
    conditions() {
      const gl = view.canvas.getContext('webgl2')!,
        info = gl.getExtension('WEBGL_debug_renderer_info'),
        home = view.home;
      return {
        pack: pack.id,
        packHash: read.hash,
        camera: {
          name: cameraName,
          position: home.position,
          target: home.target,
          fov: home.fov ?? 70,
          drift: home.drift ?? 0,
        },
        anchor: anchor ?? null,
        chest,
        canvas: [view.canvas.width, view.canvas.height],
        time: 0,
        seed: 11,
        guestLook: chest
          ? { toneMapping: 'ACESFilmic', exposure: 1.1, timesPresetExposure: true }
          : null,
        renderer: info
          ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
      };
    },
    /** Points in the pack's frame (as pack.json places things) on the picture, 0..1 from the top left; for measuring regions. */
    project(points: readonly (readonly [number, number, number])[]) {
      const home = view.home,
        eye = new PerspectiveCamera(
          home.fov ?? 70,
          view.canvas.width / view.canvas.height,
          0.1,
          1200,
        ),
        [ox, oy, oz] = pack.structure.origin;
      eye.position.set(...home.position);
      eye.lookAt(...home.target);
      eye.updateMatrixWorld();
      return points.map(([x, y, z]) => {
        const p = new Vector3(x + ox, y + oy, z + oz).project(eye);
        return [(p.x + 1) / 2, (1 - p.y) / 2];
      });
    },
    /**
     * What a switch costs as it is seen: the relight (CPU: meshing, lights), then the first frame
     * drawn and waited for (a pixel read back makes the GPU finish uploading the new meshes and
     * drawing), for each of `names` in turn, `rounds` times; and what the renderer and the JS heap
     * hold before and after (after a collection, if the page may ask for one).
     */
    timing(names: readonly (string | null)[], rounds = 5) {
      const gl = view.canvas.getContext('webgl2')!,
        pixel = new Uint8Array(4);
      const settle = () => {
        (window as { gc?: () => void }).gc?.();
        return (
          (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null
        );
      };
      const memory = () => ({
        geometries: view.renderMetrics.geometries,
        textures: view.renderMetrics.textures,
      });
      view.renderAt(0);
      const before = { heap: settle(), ...memory() },
        switches = [],
        heapByRound: (number | null)[] = [];
      for (let round = 0; round < rounds; round++)
        for (const [i, name] of names.entries()) {
          const started = performance.now();
          view.setLighting(name === null ? undefined : presetOf(pack, name));
          const relit = performance.now();
          view.renderAt(0);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          const shown = performance.now();
          switches.push({
            name,
            round,
            relightMs: +(relit - started).toFixed(2),
            firstFrameMs: +(shown - relit).toFixed(2),
            totalMs: +(shown - started).toFixed(2),
          });
          // A heap that grows round after round holds on to old light; one that levels off does not.
          if (i === names.length - 1) heapByRound.push(settle());
        }
      return {
        before,
        after: { heap: settle(), ...memory() },
        heapByRound,
        collected: typeof (window as { gc?: unknown }).gc === 'function',
        switches,
      };
    },
    /**
     * The first picture after a switch against the picture once it has settled and the one before
     * it: a switch that showed nothing, or the old light, for a frame would differ from the first and
     * match the second. Mean absolute difference per channel, 0..255, and the first picture's brightness.
     */
    switchCheck(from: string | null, to: string | null) {
      const pixels = () => {
        const g = Object.assign(document.createElement('canvas'), {
          width: view.canvas.width,
          height: view.canvas.height,
        }).getContext('2d', { willReadFrequently: true })!;
        g.drawImage(view.canvas, 0, 0);
        return g.getImageData(0, 0, view.canvas.width, view.canvas.height).data;
      };
      const differ = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
        let sum = 0;
        for (let i = 0; i < a.length; i += 4)
          sum +=
            Math.abs(a[i]! - b[i]!) +
            Math.abs(a[i + 1]! - b[i + 1]!) +
            Math.abs(a[i + 2]! - b[i + 2]!);
        return +(sum / ((a.length / 4) * 3)).toFixed(3);
      };
      view.setLighting(from === null ? undefined : presetOf(pack, from));
      view.renderAt(0);
      view.snapshot('image/png', 1);
      const old = pixels();
      view.setLighting(to === null ? undefined : presetOf(pack, to));
      // setLighting draws once itself: this is that frame, before any other.
      const first = pixels();
      view.renderAt(0);
      view.snapshot('image/png', 1);
      const settled = pixels();
      let lum = 0;
      for (let i = 0; i < first.length; i += 4)
        lum += 0.2126 * first[i]! + 0.7152 * first[i + 1]! + 0.0722 * first[i + 2]!;
      return {
        from,
        to,
        firstVsSettled: differ(first, settled),
        firstVsOld: differ(first, old),
        firstMeanLuminance: +(lum / (first.length / 4) / 255).toFixed(4),
      };
    },
  },
});

function sheet(): Promise<string> {
  const canvas = Object.assign(document.createElement('canvas'), { width: 1600, height: 900 }),
    g = canvas.getContext('2d')!;
  return Promise.all(
    views.map(
      (shown, i) =>
        new Promise<void>((resolve) => {
          const image = new Image();
          image.onload = () => {
            g.drawImage(image, (i % 2) * 800, Math.floor(i / 2) * 450, 800, 450);
            resolve();
          };
          image.src = shown.snapshot('image/png', 1);
        }),
    ),
  ).then(() => canvas.toDataURL('image/png'));
}

if (!capture && !grid) panel();

// ── The panel ─────────────────────────────────────────────────────────────────────────────────

/** The preset as the panel edits it: plain, mutable JSON. */
type Draft = { -readonly [K in keyof LightingPreset]: any };

interface Control {
  readonly group: string;
  readonly label: string;
  readonly hint: string;
  readonly get: (p: Draft) => number | string | boolean;
  readonly set: (p: Draft, v: any) => void;
  readonly kind: 'range' | 'color' | 'check';
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly when?: (p: Draft) => boolean;
}

const deg = (r: number) => (r * 180) / Math.PI,
  rad = (d: number) => (d * Math.PI) / 180;
const sunAngles = (p: Draft) => {
  const [x, y, z] = p.sun.direction;
  return {
    azimuth: (deg(Math.atan2(x, z)) + 360) % 360,
    height: deg(Math.asin(y / Math.hypot(x, y, z))),
  };
};
const sunFrom = (p: Draft, azimuth: number, height: number) => {
  const h = rad(height),
    a = rad(azimuth);
  p.sun.direction = [
    +(Math.cos(h) * Math.sin(a)).toFixed(3),
    +Math.sin(h).toFixed(3),
    +(Math.cos(h) * Math.cos(a)).toFixed(3),
  ];
};
const hasSun = (p: Draft) => p.sun !== null;
const range = (
  group: string,
  label: string,
  hint: string,
  path: string,
  min: number,
  max: number,
  step: number,
  when?: (p: Draft) => boolean,
): Control => ({
  group,
  label,
  hint,
  kind: 'range',
  min,
  max,
  step,
  ...(when ? { when } : {}),
  get: (p) => path.split('.').reduce((o: any, k) => o?.[k], p) ?? 1,
  set: (p, v) => {
    const keys = path.split('.'),
      last = keys.pop()!;
    const o = keys.reduce((o: any, k) => (o[k] ??= {}), p);
    o[last] = v;
  },
});
const color = (
  group: string,
  label: string,
  hint: string,
  path: string,
  when?: (p: Draft) => boolean,
): Control => ({ ...range(group, label, hint, path, 0, 0, 0, when), kind: 'color' });

const CONTROLS: Control[] = [
  range(
    'Overall',
    'Exposure',
    'All light on surfaces brighter or darker (blocks, objects, chest); sky and fog stay',
    'exposure',
    0.3,
    2.5,
    0.01,
  ),
  range(
    'Overall',
    'Glow of glowing things',
    'How bright lamps, fire and emissive model parts look themselves',
    'emissive',
    0,
    3,
    0.01,
  ),
  color(
    'Sky light',
    'Colour',
    'Light from the open sky: blocks under the sky, and objects/chest from above',
    'skyLight.color',
  ),
  range('Sky light', 'Strength', '', 'skyLight.intensity', 0, 2, 0.01),
  color(
    'Shadows',
    'Colour',
    'The colour of the darkest places, and the fill from below on objects/chest',
    'ambient.color',
  ),
  range(
    'Shadows',
    'Darkest level',
    'How dark unlit places get: 0 black',
    'ambient.level',
    0,
    0.3,
    0.005,
  ),
  range(
    'Shadows',
    'Corner darkening',
    'Ambient occlusion of blocks in corners and under edges',
    'ambient.occlusion',
    0,
    1,
    0.01,
  ),
  {
    group: 'Sun / moon',
    label: 'On',
    hint: 'A directional light baked into blocks with its shadows, and the key for objects if chosen',
    kind: 'check',
    get: (p) => p.sun !== null,
    set: (p, v) => {
      p.sun = v
        ? (p.sun ?? { direction: [-0.6, 0.5, 0.6], color: '#ffd2a0', intensity: 0.4, reach: 64 })
        : null;
      if (!v && p.key.from === 'sun') p.key.from = 'local';
    },
  },
  color('Sun / moon', 'Colour', '', 'sun.color', hasSun),
  range(
    'Sun / moon',
    'Strength',
    "How much of the blocks' light is the sun: sunlit faces warm, the rest in shadow",
    'sun.intensity',
    0,
    1,
    0.01,
    hasSun,
  ),
  {
    group: 'Sun / moon',
    label: 'Height',
    hint: 'Low: long shadows, raking light',
    kind: 'range',
    min: 3,
    max: 89,
    step: 1,
    when: hasSun,
    get: (p) => sunAngles(p).height,
    set: (p, v) => sunFrom(p, sunAngles(p).azimuth, v),
  },
  {
    group: 'Sun / moon',
    label: 'Direction',
    hint: 'Where the light comes from around the scene',
    kind: 'range',
    min: 0,
    max: 359,
    step: 1,
    when: hasSun,
    get: (p) => sunAngles(p).azimuth,
    set: (p, v) => sunFrom(p, v, sunAngles(p).height),
  },
  color(
    'Glowing blocks',
    'Colour',
    "The light of the structure's own lamps, lanterns, fire",
    'blockLight.color',
  ),
  color(
    'Glowing blocks',
    'Second colour',
    'Soul fire and other second-colour blocks',
    'blockLight.second',
  ),
  range('Glowing blocks', 'Strength', '', 'blockLight.intensity', 0, 2, 0.01),
  range(
    'Glowing blocks',
    'Flicker',
    'Torchlight breathing on blocks and the nearest lights on objects/chest',
    'blockLight.flicker',
    0,
    0.3,
    0.005,
  ),
  ...LOCAL_TYPES.map((type) =>
    range(
      'Local sources',
      `${type[0]!.toUpperCase()}${type.slice(1)}`,
      type === 'torch' ? "Strength of the pack's rig sources of each type (1 as placed)" : '',
      `sources.${type}.intensity`,
      0,
      3,
      0.01,
    ),
  ),
  {
    group: 'Main light on objects & chest',
    label: 'From the sun',
    hint: 'Off: from the strongest local source near the chest',
    kind: 'check',
    when: hasSun,
    get: (p) => p.key.from === 'sun',
    set: (p, v) => {
      p.key.from = v ? 'sun' : 'local';
    },
  },
  range('Main light on objects & chest', 'Strength', '', 'key.strength', 0, 6, 0.05),
  range(
    'Main light on objects & chest',
    'Fill',
    'Sky and shadow colour on them, from above and below',
    'fill',
    0,
    3,
    0.01,
  ),
  color('Fog', 'Colour', '', 'fog.color'),
  range('Fog', 'Starts at', 'Blocks from the camera', 'fog.near', 0, 120, 1),
  range('Fog', 'Full at', '', 'fog.far', 5, 200, 1),
  range('Fog', 'Glow towards the sun', '', 'fog.glow', 0, 2, 0.01, hasSun),
  color('Sky (seen)', 'Top', 'The sky behind the scene; it lights nothing', 'sky.top'),
  color('Sky (seen)', 'Horizon', '', 'sky.horizon'),
  color('Sky (seen)', 'Below', '', 'sky.bottom'),
];

function panel(): void {
  const box = document.body.appendChild(
    Object.assign(document.createElement('aside'), { className: 'panel' }),
  );
  const select = Object.assign(document.createElement('select'), { title: 'Preset' });
  const refill = () => {
    select.replaceChildren(
      new Option('Pack environment (as authored)', ''),
      ...Object.values(named()).map((p) => new Option(p.label, p.name)),
    );
    if (current && !named()[current.name])
      select.append(new Option(`${current.label} (loaded)`, current.name));
    select.value = current?.name ?? '';
  };
  const cameras = Object.assign(document.createElement('select'), { title: 'Camera' });
  cameras.append(...[...pack.cameras.keys()].map((name) => new Option(`Camera: ${name}`, name)));
  cameras.value = cameraName;
  cameras.onchange = () => {
    switchCamera(cameras.value).then(status, complain);
  };
  const info = Object.assign(document.createElement('div'), { className: 'info' });
  /** Why a change or a file was not taken: every problem, with its place; the light stays as it was. */
  const problems = Object.assign(document.createElement('ul'), {
    className: 'problems',
    hidden: true,
  });
  const complain = (error: unknown) => {
    const list =
      error instanceof LightingError
        ? error.problems.map((p) => `${p.path || '(preset)'}: ${p.message}`)
        : [error instanceof Error ? error.message : String(error)];
    problems.replaceChildren(
      ...list.map((text) => Object.assign(document.createElement('li'), { textContent: text })),
    );
    problems.hidden = false;
  };
  const clear = () => {
    problems.hidden = true;
    problems.replaceChildren();
  };
  const controls = Object.assign(document.createElement('div'), { className: 'controls' });
  const out = Object.assign(document.createElement('textarea'), {
    className: 'json',
    rows: 8,
    spellcheck: false,
    placeholder: 'Exported or pasted preset JSON',
  });
  const button = (text: string, onclick: () => void) =>
    Object.assign(document.createElement('button'), { textContent: text, onclick });
  const file = Object.assign(document.createElement('input'), {
    type: 'file',
    accept: '.json,application/json',
    hidden: true,
  });
  let draft: Draft | undefined,
    timer = 0;
  const loaded: Record<string, LightingPreset> = {};

  const show = (preset: LightingPreset | undefined) => {
    draft = preset ? (structuredClone(preset) as Draft) : undefined;
    base = preset?.name;
    apply(preset);
    refill();
    build();
    status();
    clear();
  };
  const changed = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      try {
        apply(readLightingPreset(draft));
        status();
        build(false);
        clear();
      } catch (error) {
        complain(error);
      }
    }, 40);
  };
  const status = () => {
    const m = view.renderMetrics;
    info.textContent = `${current ? current.label : 'Pack environment'} · relight ${lastMs.toFixed(1)} ms · ${m.drawCalls} draws · ${(m.triangles / 1000).toFixed(1)}k tris`;
  };
  const build = (all = true) => {
    if (!all) {
      for (const input of controls.querySelectorAll<HTMLElement>('[data-when]'))
        input.closest('label')!.hidden = !CONTROLS[Number(input.dataset.when)]!.when!(draft!);
      return;
    }
    controls.replaceChildren();
    if (!draft) {
      controls.textContent = "The pack's own light. Choose a preset to change it.";
      return;
    }
    let group = '';
    CONTROLS.forEach((control, i) => {
      if (control.group !== group) {
        group = control.group;
        controls.append(Object.assign(document.createElement('h3'), { textContent: group }));
      }
      const label = Object.assign(document.createElement('label'), { title: control.hint });
      const input = Object.assign(document.createElement('input'), {
        type: control.kind === 'check' ? 'checkbox' : control.kind,
      });
      const value = Object.assign(document.createElement('output'), {});
      const read = () => {
        const v = draft && (control.when?.(draft) ?? true) ? control.get(draft) : undefined;
        if (control.kind === 'check') input.checked = Boolean(v);
        else if (v !== undefined) input.value = String(v);
        value.textContent =
          control.kind === 'range' && v !== undefined
            ? Number(v).toFixed(control.step! < 1 ? 2 : 0)
            : '';
      };
      if (control.kind === 'range')
        Object.assign(input, { min: control.min, max: control.max, step: control.step });
      if (control.when) input.dataset.when = String(i);
      input.oninput = () => {
        control.set(
          draft!,
          control.kind === 'check'
            ? input.checked
            : control.kind === 'range'
              ? Number(input.value)
              : input.value,
        );
        read();
        if (control.kind === 'check') build();
        changed();
      };
      label.append(
        Object.assign(document.createElement('span'), { textContent: control.label }),
        input,
        value,
      );
      if (control.hint)
        label.append(Object.assign(document.createElement('small'), { textContent: control.hint }));
      label.hidden = control.when ? !control.when(draft!) : false;
      read();
      controls.append(label);
    });
  };
  select.onchange = () =>
    show(select.value ? (named()[select.value] ?? loaded[select.value]) : undefined);
  file.onchange = async () => {
    const f = file.files?.[0];
    if (f) {
      out.value = await f.text();
      load();
    }
    file.value = '';
  };
  const load = () => {
    try {
      const preset = readLightingPreset(
        JSON.parse(out.value),
        (name) => named()[name] ?? loaded[name],
      );
      loaded[preset.name] = preset;
      show(preset);
    } catch (error) {
      complain(error);
    }
  };
  box.append(
    Object.assign(document.createElement('h2'), { textContent: 'Lighting Lab' }),
    Object.assign(document.createElement('p'), {
      className: 'pack',
      textContent: `${pack.id}${chest ? ` · chest ${chest}` : ''}`,
    }),
    cameras,
    select,
    info,
    problems,
    Object.assign(document.createElement('div'), { className: 'row' }),
    controls,
    out,
    Object.assign(document.createElement('div'), { className: 'row' }),
    file,
  );
  const [top, bottom] = box.querySelectorAll('.row');
  top!.append(
    button('Reset', () => show(base ? (named()[base] ?? loaded[base]) : undefined)),
    button('Four presets', () => {
      const q = new URLSearchParams(location.search);
      q.set('grid', '');
      location.search = q.toString();
    }),
  );
  bottom!.append(
    button('Export JSON', () => {
      if (!draft) {
        out.value = 'null';
        return;
      }
      let preset: LightingPreset;
      try {
        preset = readLightingPreset(draft);
      } catch (error) {
        complain(error);
        return;
      }
      // A change of a library or pack preset; a loaded file's preset is saved whole (its name is no base a fresh page knows).
      const json = presetJson(preset, named()[base ?? '']);
      out.value = JSON.stringify(json, null, 2);
      const link = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([out.value], { type: 'application/json' })),
        download: `${(json as { name: string }).name}.json`,
      });
      link.click();
      URL.revokeObjectURL(link.href);
    }),
    button('Load JSON', () => (out.value.trim() ? load() : file.click())),
  );
  show(current);
}
