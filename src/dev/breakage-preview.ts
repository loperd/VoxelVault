import {
  ACESFilmicToneMapping,
  Box3,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShadowMaterial,
  WebGLRenderer,
} from 'three';
import { physicsReady } from '../../packages/blockworld/src/physics.ts';
import { ENDER_CASE } from '../config/cases.ts';
import { loadChestAssets } from '../adapters/outbound/chest/chest-assets.ts';
import {
  BEAM_AT,
  BURST_AT,
  ChestBreakageEffects,
} from '../adapters/outbound/chest/chest-breakage-effects.ts';
import { chestEffectColor } from '../adapters/outbound/chest/chest-appearance.ts';
import { changeChestAppearance, createChestAppearance } from '../domain/chest-appearance.ts';
import { copyChestBreakage } from '../domain/chest-breakage.ts';

/**
 * Development sheet for server-decided breakage: each row is a scenario, each column a moment
 * after the break (seconds). ?seed=7 changes every fracture. Result: window.breakSheet (JPEG).
 */
const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 7);
const times = (params.get('times') ?? '0,.12,.35,.7,1.5').split(',').map(Number);
const profile = ENDER_CASE.model.modifications;
const scenarios = [
  {
    label: 'opening · decrepit: whole chest bursts',
    moment: 'opening',
    parts: [
      { part: 'body', severity: 1, detached: true, pattern: 'shatter' },
      { part: 'lid', severity: 1, detached: true, pattern: 'shatter' },
      { part: 'latch', severity: 1, detached: true, pattern: 'shatter' },
    ],
    mods: [
      { id: 'moss', intensity: 0.8 },
      { id: 'body-cracks', intensity: 0.9 },
    ],
  },
  {
    label: 'opening · lid falls off, latch breaks',
    moment: 'opening',
    parts: [
      { part: 'lid', severity: 0.6, detached: true, pattern: 'fall' },
      { part: 'latch', severity: 0.8, detached: true, pattern: 'fall' },
      { part: 'body', severity: 0.5, detached: false, pattern: 'shatter' },
    ],
    mods: [{ id: 'latch-rust', intensity: 0.9 }],
  },
  {
    label: 'opening · body splits',
    moment: 'opening',
    parts: [{ part: 'body', severity: 0.8, detached: true, pattern: 'split' }],
    mods: [{ id: 'frost', intensity: 0.7 }],
  },
  {
    label: 'impact · body crumbles',
    moment: 'impact',
    parts: [
      { part: 'body', severity: 0.9, detached: true, pattern: 'crumble' },
      { part: 'lid', severity: 0.5, detached: false, pattern: 'shatter' },
    ],
    mods: [{ id: 'body-cracks', intensity: 0.8 }],
  },
  {
    label: 'impact · latch falls off, lid chips',
    moment: 'impact',
    parts: [
      { part: 'latch', severity: 0.7, detached: true, pattern: 'fall' },
      { part: 'lid', severity: 0.7, detached: false, pattern: 'shatter' },
    ],
    mods: [{ id: 'latch-patina', intensity: 0.7 }],
  },
  {
    label: 'opening · rusty latch breaks where it rusted (close-up)',
    moment: 'opening',
    zoom: true,
    parts: [{ part: 'latch', severity: 0.9, detached: true, pattern: 'split' }],
    mods: [{ id: 'latch-rust', intensity: 1 }],
  },
  {
    label: 'opening · intact: the beam blows snow, crystals and cobweb off',
    moment: 'opening',
    parts: [],
    mods: [
      { id: 'snow', intensity: 0.9 },
      { id: 'end-crystals', intensity: 1 },
      { id: 'cobweb', intensity: 1 },
      { id: 'vines', intensity: 0.8 },
    ],
  },
  {
    label: 'opening · snowy lid falls off, the beam throws it',
    moment: 'opening',
    parts: [{ part: 'lid', severity: 0.6, detached: true, pattern: 'fall' }],
    mods: [
      { id: 'snow', intensity: 0.9 },
      { id: 'end-crystals', intensity: 1 },
    ],
  },
  {
    label:
      'landing · intact: vines tear off and drift down, snow and crystals at the rim fall, cobweb sticks, the latch swings outwards',
    moment: 'impact',
    parts: [],
    mods: [
      { id: 'snow', intensity: 1 },
      { id: 'end-crystals', intensity: 1 },
      { id: 'vines', intensity: 0.9 },
      { id: 'cobweb', intensity: 1 },
    ],
  },
] as const;

await physicsReady();
const width = 360,
  height = 300;
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(width, height, false);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = !params.get('noshadow');
renderer.shadowMap.type = PCFSoftShadowMap;
renderer.localClippingEnabled = true;
renderer.setClearColor(0x1b2a2c, 1);
const sheet = document.createElement('canvas');
sheet.width = width * times.length;
sheet.height = (height + 22) * scenarios.length;
const context = sheet.getContext('2d')!;
context.fillStyle = '#1b2a2c';
context.fillRect(0, 0, sheet.width, sheet.height);
context.font = '13px system-ui';

for (const [row, scenario] of scenarios.entries()) {
  const appearance = changeChestAppearance(createChestAppearance(4242), {
    modifications: params.get('nomods') ? [] : scenario.mods.map((item) => ({ ...item })),
  });
  const breakage = copyChestBreakage(
    {
      seed: seed + row,
      moment: scenario.moment,
      parts: scenario.parts.map((item) => ({ ...item })),
    },
    profile,
  );
  for (const [column, time] of times.entries()) {
    const assets = await loadChestAssets(
      new URL('/', location.href),
      new AbortController().signal,
      ENDER_CASE.model,
      appearance,
    );
    const scene = new Scene();
    scene.add(assets.visual, new HemisphereLight(0xffffff, 0x435846, 2));
    const light = new DirectionalLight(0xffffff, 3);
    light.position.set(3, 6, -4);
    light.castShadow = true;
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = 0.02;
    scene.add(light);
    const floor = new Mesh(new PlaneGeometry(20, 20), new ShadowMaterial({ opacity: 0.3 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    // Resting pose like the game: chest base on the floor.
    assets.visual.updateMatrixWorld(true);
    const baseY = -new Box3().setFromObject(assets.visual).min.y;
    assets.visual.position.y = baseY;
    assets.visual.updateMatrixWorld(true);
    const accent = '#' + chestEffectColor(appearance).toString(16).padStart(6, '0');
    const effects = new ChestBreakageEffects(
      scene,
      assets.visual,
      profile,
      appearance,
      breakage,
      accent,
      0,
    );
    effects.start(false);
    const step = 1 / 60;
    if (scenario.moment === 'impact') {
      effects.impact();
      effects.landed(1);
      for (let t = 0; t < time; t += step) effects.update(step);
    } else {
      // Charge up to the burst (~1.4 s of a 6 s opening), then run `time` seconds past it.
      const duration = 6;
      // Frames count from the moment that matters: the burst of a break, or the beam of an intact opening.
      const from = scenario.parts.some((part) => part.detached) ? BURST_AT : BEAM_AT;
      for (let t = 0; t < from * duration + time; t += step) {
        assets.visual.position.set(0, baseY, 0);
        assets.visual.scale.setScalar(1);
        effects.update(step, t / duration);
        // The intact opening's beam (in the game the scene fires it at BEAM_AT).
        if (!breakage.destroyed && t / duration >= BEAM_AT) effects.beam(1);
      }
    }
    const camera = new PerspectiveCamera(42, width / height, 0.1, 50);
    if ('zoom' in scenario) {
      camera.position.set(-1.3, 1.9, -2.9);
      camera.lookAt(0, 0.9, -0.4);
    } else {
      camera.position.set(-3.4, 2.6, -4.8);
      camera.lookAt(0, 0.5, 0);
    }
    renderer.render(scene, camera);
    const x = column * width,
      y = row * (height + 22);
    context.drawImage(renderer.domElement, x, y + 22);
    context.fillStyle = '#e8eef0';
    context.fillText(column === 0 ? `${scenario.label} · +${time}s` : `+${time}s`, x + 6, y + 15);
    effects.dispose();
    assets.dispose();
    floor.geometry.dispose();
    (floor.material as ShadowMaterial).dispose();
  }
}
document.body.append(sheet);
(window as unknown as { breakSheet: string }).breakSheet = sheet.toDataURL('image/jpeg', 0.88);
document.getElementById('status')!.textContent = 'ready';
