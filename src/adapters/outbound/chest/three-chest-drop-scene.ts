import { chestEffectColor } from './chest-appearance.ts';
import {
  createChestAppearance,
  copyChestAppearance,
  type ChestAppearance,
} from '../../../domain/chest-appearance.ts';
import { ENDER_CASE, type ChestModelDefinition } from '../../../config/cases.ts';
import {
  ACESFilmicToneMapping,
  AnimationMixer,
  Box3,
  Color,
  LoopOnce,
  Sphere,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  PointLight,
  type Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  ShadowMaterial,
  Vector3,
} from 'three';
import {
  guestKey,
  type Guest,
  type GuestWorld,
} from '../../../../packages/blockworld/src/index.ts';
import type { ChestDropPort } from '../../../application/ports/chest-preview.ts';
import type { ChestPresentationPort } from '../../../application/ports/chest-presentation.ts';
import type { ChestHandles } from '../../../application/ports/chest-handles.ts';
import { FrameTimeline } from '../browser/frame-timeline.ts';
import { FixedStepper } from '../browser/fixed-stepper.ts';
import { browserFrameEnvironment, FrameScheduler } from '../browser/frame-scheduler.ts';
import { normalizeBaseUrl } from '../data/asset-url.ts';
import { loadChestAssets, type ChestAssets } from './chest-assets.ts';
import { disposeObject } from './dispose-object.ts';
import { WorldBodyPhysics } from './world-body-physics.ts';
import type { PhysicsWorldPort, Pose } from './physics-world-port.ts';
import { ChestFractureEffects } from './chest-fracture-effects.ts';
import { BEAM_AT, BURST_AT, ChestBreakageEffects } from './chest-breakage-effects.ts';
import { gameAudio } from '../browser/game-audio.ts';
import { NO_BREAKAGE, type ChestBreakage } from '../../../domain/chest-breakage.ts';
import { ChestImpactEffects } from './chest-impact-effects.ts';
import { ChestOpeningEffects } from './chest-opening-effects.ts';
import { PREVIEW_POSE, SPAWN_POSE } from './physics-config.ts';
import { CHEST_WIDTH } from './chest-bounds.ts';

/** The chest's own light, used unless its world says otherwise (see GuestLight): key from above-behind-right. */
const KEY_POSITION: [number, number, number] = [3, 6, -4];
const KEY_DISTANCE = Math.hypot(...KEY_POSITION),
  KEY_STRENGTH = 3,
  FILL_STRENGTH = 2;

/** The chest is a block and a half wide: bigger than the world's blocks, the thing that matters. */
const BLOCKS_WIDE = 1.5;
/** Its units to a block. */
const UNIT = CHEST_WIDTH / BLOCKS_WIDE;

/** Opening: the chest rises, spinning, to where it falls from (seconds), then charges. */
const RISE = 1.15,
  CHARGE = 1.35;
// The intro: the panels slide in first, then the chest lowers from above the view and hangs.
const ENTRY_DELAY = 0.5,
  ENTRY_SECONDS = 1.2,
  ENTRY_HEIGHT = 7;
/** Turns about its own axis on the way up: fast in the middle, settling to face the viewer again. */
const RISE_TURNS = 2;

/** How long to wait for a world to take the chest in before giving up. */
const WORLD_WAIT_MS = 10_000;

/**
 * The chest, a guest of whatever world it is shown in. The world is the base: it owns the canvas,
 * the camera, the ground and the physics. The chest brings its model, lights, effects and body; it
 * falls under the world's physics onto the world's ground, is drawn by the world's camera, and the
 * world's camera moves in on it when it opens. A world may pull its handles (gusts, tremors, light)
 * and blow it about with real blasts.
 */
export class ThreeChestDropScene implements ChestDropPort, ChestPresentationPort {
  readonly element: HTMLDivElement;
  private readonly baseUrl: URL;
  private readonly modelDefinition: ChestModelDefinition;
  private readonly appearance: ChestAppearance;
  private readonly effectColor: number;
  private readonly onImpact?: () => void;
  private readonly view: Window;
  private readonly document: Document;
  private readonly errors = new Set<(error: unknown) => void>();
  private readonly stepper = new FixedStepper();
  private scene?: Scene;
  private floor?: Mesh;
  private assets?: ChestAssets;
  private physics?: PhysicsWorldPort & { settle(): void };
  private scheduler?: FrameScheduler;
  private detachAbort?: () => void;
  /** Everything of the chest's, standing on the world's anchor block. */
  private readonly root = new Group();
  private world?: GuestWorld;
  private worldPhysics?: WorldBodyPhysics;
  private arrived?: () => void;
  /** Whether `arrival` has been kept: a world came and its physics is ready. */
  private present = false;
  /** Where the chest was when its world went away: it stands there in the next one. */
  private carried?: { pose: Pose; moving: boolean };
  private arrival: Promise<void>;
  private generation = 0;
  private initialPose = false;
  private prepared = false;
  private disposed = false;
  private mixer?: AnimationMixer;
  private opening?: { advance(delta: number): void; cancel(error: unknown): void };
  private mode: 'preview' | 'drop' | 'opening' | 'stopped' = 'stopped';
  /** What the world is doing to the chest right now (tremor, light); see `handles`. */
  private worldTremor = { left: 0, total: 0, strength: 0 };
  private worldFlash = { left: 0, total: 0, peak: 0 };
  private worldLight?: PointLight;
  /** The chest's own light, in the colours of the world it stands in. */
  private skyLight?: HemisphereLight;
  private keyLight?: DirectionalLight;
  private worldBase?: Vector3;
  private woken = false;

  /**
   * The handles a world may pull. The chest lives on its own (stands, falls, opens); a world can
   * only blow at it, shake the ground under it and throw light on it. It never learns which world.
   */
  readonly handles: ChestHandles = {
    gust: (strength) => {
      this.breakageEffects?.kick(Math.max(0, Math.min(1, strength)) * 1.4);
      this.wake();
    },
    tremor: (strength, seconds) => {
      if (this.view.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const left = Math.max(this.worldTremor.left, seconds);
      this.worldTremor = { left, total: left, strength: Math.max(0, Math.min(1, strength)) };
      this.wake();
    },
    light: (color, intensity, seconds) => {
      if (!this.worldLight) return;
      this.worldLight.color = new Color(color);
      this.worldFlash = {
        left: seconds,
        total: seconds,
        peak: Math.max(0, Math.min(1, intensity)) * 6,
      };
      this.wake();
    },
  };
  private previewTime = 0;

  /** What a world takes in: the chest's things, one block wide, in the chest's own look. */
  readonly guest: Guest = {
    root: this.root,
    unit: UNIT,
    // The three-quarter view it was made to be seen in: front and one side.
    front: [-5, -7],
    look: {
      toneMapping: ACESFilmicToneMapping,
      exposure: 1.1,
      srgb: true,
      shadows: true,
      clipping: true,
    },
    enter: (world) => {
      void this.enter(world);
    },
    leave: () => this.leave(),
    // The world was lit another way (a lighting preset): the chest follows it.
    relight: () => {
      if (this.world) this.lightBy(this.world);
    },
  };
  private readonly entranceTimeline: FrameTimeline;
  private previewEntrance?: Animation;
  private effects?: ChestOpeningEffects;
  private soundMuted = false;
  private impactEffects?: ChestImpactEffects;
  private fractureEffects?: ChestFractureEffects;
  private breakageEffects?: ChestBreakageEffects;
  private breakage: ChestBreakage;
  private impactTriggered = false;
  private readonly impactCorner = new Vector3();
  private landing?: { advance(delta: number): void; cancel(error: unknown): void };

  constructor(
    baseUrl: string | URL,
    document: Document = globalThis.document,
    modelDefinition: ChestModelDefinition = ENDER_CASE.model,
    appearance: ChestAppearance = createChestAppearance(),
    onImpact?: () => void,
    breakage: ChestBreakage = NO_BREAKAGE,
    effectColor = chestEffectColor(appearance),
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.breakage = breakage;
    this.modelDefinition = modelDefinition;
    this.appearance = copyChestAppearance(appearance);
    this.effectColor = effectColor;
    this.onImpact = onImpact;
    this.document = document;
    if (!document.defaultView) throw new Error('The chest scene requires a browser window.');
    this.view = document.defaultView;
    this.entranceTimeline = new FrameTimeline(browserFrameEnvironment(this.view, document));
    this.element = document.createElement('div');
    this.element.className = 'chest-canvas';
    this.arrival = new Promise((resolve) => {
      this.arrived = resolve;
    });
    // Hidden until it is given a pose and shown: a model fresh from loading stands at its own
    // origin, its middle on the floor, half sunk into the ground.
    this.element.hidden = true;
    this.root.visible = false;
  }

  /** A world took the chest in: its body goes into that world's physics, where it was. */
  private async enter(world: GuestWorld): Promise<void> {
    this.world = world;
    // A world that let the chest go before its physics was ready (it closed) is no failure.
    const physics = await world.physics.catch((error) => {
      if (this.world === world) this.runtimeFailure(error);
      return undefined;
    });
    if (!physics || this.world !== world) return;
    const carried = this.carried;
    this.carried = undefined;
    this.lightBy(world);
    this.worldPhysics = new WorldBodyPhysics(physics, world, UNIT);
    this.physics = this.worldPhysics;
    // A chest that hung keeps hanging in the new world; only one that was falling goes on falling.
    if (carried && this.assets) {
      this.physics.resetChest(this.assets.colliders, carried.pose);
      this.physics.setChestMoving(carried.moving);
      this.syncPose();
    }
    // Its frames stopped with the old world: whatever it was doing goes on.
    if (
      this.mode !== 'stopped' &&
      !this.view.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      this.scheduler?.start();
    this.present = true;
    this.arrived?.();
    this.render();
  }

  /** The world went away: the chest waits for the next one. */
  private leave(): void {
    // Its body goes with the old world's physics: remember where it stood and stop moving.
    this.carried = this.worldPhysics?.carryOver();
    this.scheduler?.stop();
    this.worldPhysics?.dispose();
    this.worldPhysics = undefined;
    this.physics = undefined;
    this.world = undefined;
    // Whoever already waits for a world keeps waiting on the same promise; only a kept one is renewed.
    if (this.present) {
      this.present = false;
      this.arrival = new Promise((resolve) => {
        this.arrived = resolve;
      });
    }
  }

  /** Shown or not: the placeholder in the page and the chest in the world together. */
  private show(visible: boolean): void {
    this.element.hidden = !visible;
    this.root.visible = visible;
    this.world?.draw();
  }

  setSoundMuted(muted: boolean): void {
    this.soundMuted = muted;
    this.effects?.setMuted(muted);
    gameAudio.setMuted(muted);
  }

  /**
   * A cropped picture of what is left of the chest (fragments, debris, standing parts), for the
   * destruction screen. Rendered and read in the same task, so the drawing buffer is still valid.
   */
  captureWreck(): string | undefined {
    const world = this.world,
      scene = this.scene,
      assets = this.assets;
    if (!world || !scene || !assets) return undefined;
    try {
      // Frame what lies around the chest (fragments, standing parts, debris), not crumbs far away.
      // All in the world's units: the chest stands on the anchor, a block and a half wide.
      const block = 1 / UNIT,
        origin = assets.visual.getWorldPosition(new Vector3()),
        box = new Box3(),
        point = new Vector3();
      origin.y = world.anchor[1];
      scene.traverse((object) => {
        if (!(object instanceof Mesh) || object === this.floor) return;
        for (let shown: Object3D | null = object; shown; shown = shown.parent)
          if (!shown.visible) return;
        object.getWorldPosition(point);
        if (point.distanceTo(origin) < 2.2 * block) box.expandByObject(object);
      });
      if (box.isEmpty()) return undefined;
      const sphere = box.getBoundingSphere(new Sphere());
      // A dedicated camera from the world's own viewing direction, close enough to fill the shot.
      const width = 720,
        height = 600,
        shot = new PerspectiveCamera(32, width / height, 0.05 * block, 60);
      const direction = world.camera.position.clone().sub(sphere.center).normalize();
      const distance = (sphere.radius / Math.sin((shot.fov * Math.PI) / 360)) * 1.08;
      shot.position.copy(sphere.center).addScaledVector(direction, distance);
      shot.lookAt(sphere.center);
      shot.updateMatrixWorld();
      return world.picture(shot, width, height);
    } catch {
      return undefined;
    }
  }

  unlockAudio(): void {
    this.effects?.unlock();
    gameAudio.unlock();
  }

  async stageForDrop(signal: AbortSignal): Promise<void> {
    this.assertPrepared(signal);
    if (this.mode !== 'preview') return;
    this.previewEntrance?.cancel();
    this.previewEntrance = undefined;
    this.scheduler?.stop();
    this.detachAbort?.();
    this.detachAbort = undefined;
    const visual = this.assets!.visual;
    const position = visual.position.clone(),
      rotation = visual.quaternion.clone();
    const scale = visual.scale.x;
    const reduced = this.view.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = reduced ? 0 : RISE + CHARGE;
    // Its body goes up to where it falls from, held; the chest follows it up, spinning.
    this.physics!.resetChest(this.assets!.colliders, SPAWN_POSE);
    this.physics!.setChestMoving(false);
    this.fractureEffects?.start(reduced);
    let chargeStarted = false;
    const spin = new Quaternion(),
      up = new Vector3(0, 1, 0);
    await this.entranceTimeline.run(
      duration,
      (elapsed) => {
        const progress = duration ? Math.min(elapsed / RISE, 1) : 1;
        // Ease in and out: it lifts off slowly, whirls up, and slows to a stop at the top.
        const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
        this.syncPose();
        visual.position.lerpVectors(position, visual.position.clone(), eased);
        visual.quaternion.slerpQuaternions(rotation, visual.quaternion.clone(), eased);
        visual.quaternion.premultiply(spin.setFromAxisAngle(up, eased * RISE_TURNS * Math.PI * 2));
        visual.scale.setScalar(scale + (1 - scale) * eased);
        // Sparks swirl up under it as it rises.
        if (!reduced && progress < 1)
          this.impactEffects?.approach(
            visual.position.x,
            visual.position.y,
            visual.position.z,
            false,
          );
        if (!reduced && elapsed > RISE) {
          const charge = Math.min((elapsed - RISE) / CHARGE, 1);
          if (!chargeStarted) {
            this.effects?.charge();
            chargeStarted = true;
          }
          const envelope = Math.sin(charge * Math.PI);
          visual.position.y += envelope * 0.16;
          visual.position.x += Math.sin(charge * 82) * envelope * 0.014;
          visual.position.z += Math.cos(charge * 69) * envelope * 0.01;
          this.fractureEffects?.charge(charge);
          this.impactEffects?.approach(
            visual.position.x,
            visual.position.y,
            visual.position.z,
            false,
          );
        }
        this.render();
      },
      signal,
    );
    // It shook up there, and falls from there: no reset (and no flicker) before the drop.
    this.syncPose();
    this.initialPose = true;
  }

  subscribeErrors(listener: (error: unknown) => void): () => void {
    if (this.disposed) return () => {};
    this.errors.add(listener);
    return () => {
      this.errors.delete(listener);
    };
  }

  /**
   * How the chest breaks, as the server decided it for this opening; drawn by the next fall and
   * opening. Set before the drop.
   */
  setBreakage(breakage: ChestBreakage): void {
    this.breakage = breakage;
    if (!this.scene || !this.assets) return;
    this.breakageEffects?.dispose();
    this.breakageEffects = this.createBreakageEffects(this.scene);
  }

  private createBreakageEffects(scene: Scene): ChestBreakageEffects {
    return new ChestBreakageEffects(
      scene,
      this.assets!.visual,
      this.modelDefinition.modifications,
      this.assets!.appearance,
      this.breakage,
      '#' + this.effectColor.toString(16).padStart(6, '0'),
      0,
      gameAudio,
    );
  }

  async prepare(signal: AbortSignal): Promise<void> {
    this.assertAlive(signal);
    if (this.prepared) return;
    this.release();
    const generation = this.generation;
    try {
      // The chest's things load while it waits for a world to stand in (and its physics to fall in).
      await Promise.all([
        loadChestAssets(
          this.baseUrl,
          signal,
          this.modelDefinition,
          this.appearance,
          this.effectColor,
        ).then((assets) => {
          if (!this.isCurrent(generation, signal)) {
            assets.dispose();
            signal.throwIfAborted();
            throw new Error('Scene preparation was cancelled.');
          }
          this.assets = assets;
        }),
        this.awaitWorld(signal),
      ]);
      this.assertAlive(signal);
      if (this.generation !== generation || !this.assets || !this.physics)
        throw new Error('Scene preparation was cancelled.');
      const scene = new Scene();
      this.scene = scene;
      this.root.add(scene);
      scene.add(this.assets.visual);
      const effectColor = this.effectColor;
      this.fractureEffects = new ChestFractureEffects(
        this.assets.visual,
        effectColor,
        this.assets.appearance,
        this.modelDefinition.modifications,
      );
      this.effects = new ChestOpeningEffects(this.assets.visual, effectColor);
      this.effects.setMuted(this.soundMuted);
      this.impactEffects = new ChestImpactEffects(scene, effectColor);
      this.breakageEffects = this.createBreakageEffects(scene);
      this.mixer = new AnimationMixer(this.assets.animationRoot);
      const sky = new HemisphereLight(0xffffff, 0x435846, FILL_STRENGTH);
      this.skyLight = sky;
      scene.add(sky);
      const light = new DirectionalLight(0xffffff, KEY_STRENGTH);
      this.keyLight = light;
      light.position.set(...KEY_POSITION);
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.camera.left = -5;
      light.shadow.camera.right = 5;
      light.shadow.camera.top = 5;
      light.shadow.camera.bottom = -5;
      light.shadow.camera.near = 0.1;
      light.shadow.camera.far = 20;
      // Without a bias every lit face catches its own shadow (shadow acne): fine diagonal stripes
      // that get obvious as the chest moves towards the camera. normalBias handles grazing angles.
      light.shadow.bias = -0.0005;
      light.shadow.normalBias = 0.02;
      // The light's target stands with the chest, wherever the world puts it.
      scene.add(light, light.target);
      // The world's light on the chest (lava, lightning, an ender flash): off until a world pulls it.
      this.worldLight = new PointLight(0xffffff, 0, 6, 1.6);
      this.worldLight.position.set(-1.6, 2.4, -2.2);
      scene.add(this.worldLight);
      // Catches the chest's shadow on the world's ground; nudged towards the camera so it never
      // flickers against the ground it lies on.
      const floor = new Mesh(
        new PlaneGeometry(20, 20),
        new ShadowMaterial({
          opacity: 0.25,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -4,
        }),
      );
      this.floor = floor;
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      scene.add(floor);
      if (this.world) this.lightBy(this.world);
      this.scheduler = new FrameScheduler(
        browserFrameEnvironment(this.view, this.document),
        (delta) => this.frame(delta),
        () => this.stepper.reset(),
        (error) => this.runtimeFailure(error),
      );
      this.prepared = true;
      this.render();
    } catch (error) {
      if (this.generation === generation) this.release();
      throw error;
    }
  }

  /** Lit as the world lights things: its sky, its ground, its main light (or white, the chest's own). */
  private lightBy(world: GuestWorld): void {
    const light = world.light;
    this.skyLight?.color.set(light?.sky ?? 0xffffff);
    this.skyLight?.groundColor.set(light?.ground ?? 0x435846);
    this.keyLight?.color.set(light?.key ?? 0xffffff);
    // Where the world's key is and how strong, when it says: the chest lit by the light the blocks are.
    const from = guestKey(world, KEY_DISTANCE);
    this.keyLight?.position.set(...(from ?? KEY_POSITION));
    if (this.keyLight) this.keyLight.intensity = light?.keyStrength ?? KEY_STRENGTH;
    if (this.skyLight) this.skyLight.intensity = light?.fillStrength ?? FILL_STRENGTH;
  }

  async preview(signal: AbortSignal): Promise<void> {
    await this.reset(signal);
    this.assertPrepared(signal);
    this.mode = 'preview';
    this.previewTime = 0;
    this.initialPose = false;
    // It floats in the middle of the view, held: the world's physics leaves it be until it is opened.
    this.physics!.resetChest(this.assets!.colliders, PREVIEW_POSE);
    this.physics!.setChestMoving(false);
    this.syncPose();
    this.show(true);
    this.render();
    const scheduler = this.scheduler!;
    const stop = () => scheduler.stop();
    signal.addEventListener('abort', stop, { once: true });
    this.detachAbort = () => signal.removeEventListener('abort', stop);
    if (!this.view.matchMedia('(prefers-reduced-motion: reduce)').matches) scheduler.start();
  }

  async drop(signal: AbortSignal): Promise<void> {
    this.assertPrepared(signal);
    if (!this.initialPose) await this.reset(signal);
    this.assertPrepared(signal);
    this.detachAbort?.();
    const scheduler = this.scheduler!;
    const stop = () => {
      scheduler.stop();
      this.landing?.cancel(signal.reason);
    };
    signal.addEventListener('abort', stop, { once: true });
    this.detachAbort = () => signal.removeEventListener('abort', stop);
    this.initialPose = false;
    this.mode = 'drop';
    // Let go: straight down from where it hung, level, under the world's gravity.
    this.physics!.setChestMoving(true);
    this.impactTriggered = false;
    this.fractureEffects?.start(this.view.matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.breakageEffects?.start(this.view.matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.show(true);
    await new Promise<void>((resolve, reject) => {
      let elapsed = 0;
      const cleanup = () => {
        this.landing = undefined;
        this.scheduler?.stop();
        this.mode = 'stopped';
        this.detachAbort?.();
        this.detachAbort = undefined;
      };
      this.landing = {
        advance: (delta) => {
          elapsed += delta;
          // A chest that broke on landing first lets its pieces fall and settle.
          if (this.physics!.isChestSleeping() && (this.breakageEffects?.settled ?? true)) {
            cleanup();
            resolve();
          } else if (elapsed > 15) {
            cleanup();
            reject(new Error('The chest did not settle on the floor.'));
          }
        },
        cancel: (error) => {
          cleanup();
          reject(error);
        },
      };
      this.scheduler!.start();
    });
  }

  open(signal: AbortSignal): Promise<void> {
    this.assertPrepared(signal);
    if (this.opening) return Promise.reject(new Error('The chest is already opening.'));
    this.scheduler!.stop();
    this.detachAbort?.();
    this.detachAbort = undefined;
    this.mode = 'opening';
    // Whatever the landing left on the ground is over: its frames ran out with the fall.
    this.impactEffects?.reset();
    // A chest that will be destroyed never opens: no lid swing, no light from inside, only the
    // energy building up until it bursts.
    const destroyed = this.breakage.destroyed;
    if (!destroyed) this.effects?.start();
    this.show(true);
    const mixer = this.mixer!,
      assets = this.assets!;
    const clips = assets.animations;
    const actions = clips.map((clip) => mixer.clipAction(clip));
    const reducedMotion = this.view.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const clipDuration = Math.max(...clips.map((clip) => clip.duration));
    const pending = new Set(actions);
    const start = assets.visual.position.clone();
    let elapsed = 0;
    if (assets.key) assets.key.visible = true;
    return new Promise<void>((resolve, reject) => {
      let complete = false;
      const finished = (event: { action: (typeof actions)[number] }) => {
        pending.delete(event.action);
      };
      const cleanup = () => {
        mixer.removeEventListener('finished', finished);
        signal.removeEventListener('abort', abort);
        this.opening = undefined;
        this.mode = 'stopped';
        this.scheduler?.stop();
      };
      const cancel = (error: unknown) => {
        if (complete) return;
        complete = true;
        cleanup();
        mixer.stopAllAction();
        this.effects?.stop();
        reject(error);
      };
      const abort = () => cancel(signal.reason);
      // The lid unlatching gives the hanging parts a small knock.
      this.breakageEffects?.kick(0.4);
      this.opening = {
        cancel,
        advance: (delta) => {
          if (reducedMotion) delta = Math.max(delta, clipDuration + 0.3);
          elapsed += delta;
          // Original 25-frame movement expressed in seconds; physics no longer owns the visual pose.
          const progress = Math.min(elapsed / (25 / 60), 1);
          // The camera moves in on the chest (the world behind comes closer with it); the chest
          // itself keeps its real size, so fragments are never larger than it was.
          const eased = 1 - (1 - progress) ** 3;
          assets.visual.position.copy(start);
          // A fifth of the way in, the aim raised half a block: the chest fills more of the view.
          this.world?.approach(0.2 * eased, 0.5 * eased);
          if (!destroyed) {
            mixer.update(delta);
            this.effects?.update(elapsed / (clipDuration + 0.3), reducedMotion);
            // At full power the beam is a force: whatever lies loose on top is blown away.
            if (elapsed / (clipDuration + 0.3) >= BEAM_AT) this.breakageEffects?.beam(1);
          }
          const effectStep = Math.min(delta, 0.1);
          this.fractureEffects?.update(effectStep, false);
          // After the pose: the energy build-up swells and shakes the chest on top of it.
          this.breakageEffects?.update(effectStep, elapsed / (clipDuration + 0.3));
          this.applyWorld(effectStep);
          this.render();
          // A destroyed chest has nothing left to open: end shortly after the burst settles.
          const wrecked =
            destroyed &&
            this.breakageEffects?.broken === true &&
            elapsed >= BURST_AT * (clipDuration + 0.3) + 1.8;
          if (wrecked || (pending.size === 0 && progress === 1 && elapsed >= clipDuration + 0.3)) {
            complete = true;
            cleanup();
            resolve();
          }
        },
      };
      mixer.addEventListener('finished', finished);
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (!destroyed)
          for (const action of actions) {
            action.reset().setLoop(LoopOnce, 1);
            action.clampWhenFinished = true;
            action.play();
          }
        this.scheduler!.start();
      } catch (error) {
        cancel(error);
      }
    });
  }

  hide(): void {
    this.impactEffects?.reset();
    this.fractureEffects?.reset();
    this.entranceTimeline.cancel();
    this.previewEntrance?.cancel();
    this.previewEntrance = undefined;
    this.effects?.stop();
    this.impactEffects?.reset();
    this.fractureEffects?.reset();
    this.landing?.cancel(new Error('The chest was hidden during its fall.'));
    this.opening?.cancel(new Error('The chest was hidden before opening finished.'));
    this.scheduler?.stop();
    this.mode = 'stopped';
    this.show(false);
  }

  async reset(signal: AbortSignal): Promise<void> {
    this.assertPrepared(signal);
    this.entranceTimeline.cancel();
    this.previewEntrance?.cancel();
    this.previewEntrance = undefined;
    this.show(false);
    this.effects?.stop();
    this.impactEffects?.reset();
    this.fractureEffects?.reset();
    this.landing?.cancel(new Error('The chest fall was reset.'));
    this.opening?.cancel(new Error('The chest opening was reset.'));
    this.scheduler!.stop();
    this.detachAbort?.();
    this.detachAbort = undefined;
    this.mode = 'stopped';
    this.mixer!.stopAllAction();
    this.breakageEffects?.reset();
    this.floor!.visible = true;
    this.mixer!.setTime(0);
    this.world?.approach(0, 0);
    this.assets!.restore();
    this.physics!.resetChest(this.assets!.colliders, SPAWN_POSE);
    this.physics!.setChestMoving(false);
    this.initialPose = true;
    this.syncPose();
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.errors.clear();
    this.entranceTimeline.dispose();
    this.release();
    this.element.remove();
  }

  private frame(deltaSeconds: number): void {
    this.assets?.modifications.update(Math.min(deltaSeconds, 0.1));
    if (!this.element.isConnected) {
      this.stepper.reset();
      return;
    }
    if (this.mode === 'preview') {
      const delta = Math.min(deltaSeconds, 0.1);
      this.previewTime += delta;
      this.syncPose();
      // Floating: a slow bob over its spot.
      this.assets!.visual.position.y += Math.sin(this.previewTime * 1.6) * 0.045;
      const entry = Math.min(Math.max((this.previewTime - ENTRY_DELAY) / ENTRY_SECONDS, 0), 1);
      this.assets!.visual.position.y += ENTRY_HEIGHT * (1 - entry) ** 3;
      this.breakageEffects?.update(delta);
      this.applyWorld(Math.min(deltaSeconds, 0.1));
      this.render();
      return;
    }
    if (this.mode === 'stopped') {
      this.worldOnly(Math.min(deltaSeconds, 0.1));
      return;
    }
    // Opening time follows visible elapsed time, even when rendering is slow.
    if (this.mode === 'opening') {
      this.opening?.advance(deltaSeconds);
      return;
    }
    if (this.mode !== 'drop') return;
    let simulated = 0;
    this.stepper.advance(deltaSeconds, (step) => {
      this.physics!.step(step);
      simulated += step;
    });
    this.syncPose();
    if (!this.impactTriggered) {
      const visual = this.assets!.visual,
        lowest = this.lowestCorner();
      this.impactEffects?.approach(
        visual.position.x,
        visual.position.y,
        visual.position.z,
        this.view.matchMedia('(prefers-reduced-motion: reduce)').matches,
      );
      if (lowest < 0.06) {
        this.impactTriggered = true;
        this.impactEffects?.trigger(
          visual.position.x,
          visual.position.z,
          this.view.matchMedia('(prefers-reduced-motion: reduce)').matches,
        );
        this.effects?.impact();
        // Cracks open on landing only when the decided fate breaks the chest there.
        if (this.breakageEffects?.breaksOnImpact) this.fractureEffects?.impact();
        this.breakageEffects?.impact();
        // Every landing jolts the chest: the latch and vines swing, snow at the edges slides off.
        this.breakageEffects?.landed(1);
        this.onImpact?.();
      }
    }
    this.impactEffects?.update(simulated);
    this.fractureEffects?.update(simulated, !this.impactTriggered);
    this.breakageEffects?.update(simulated);
    // The chest is solid: the landing is a jolt (dust, swinging latch, falling vines), never a squash.
    this.applyWorld(simulated);
    this.render();
    this.landing?.advance(simulated);
  }

  /** Height of the chest's lowest corner above the floor. */
  private lowestCorner(): number {
    const visual = this.assets!.visual;
    let lowest = Infinity;
    for (const box of this.assets!.colliders) {
      for (const x of [-1, 1])
        for (const y of [-1, 1])
          for (const z of [-1, 1]) {
            this.impactCorner.set(
              box.center.x + x * box.halfExtents.x,
              box.center.y + y * box.halfExtents.y,
              box.center.z + z * box.halfExtents.z,
            );
            this.impactCorner.applyQuaternion(visual.quaternion).add(visual.position);
            lowest = Math.min(lowest, this.impactCorner.y);
          }
    }
    return lowest;
  }

  /** A world pulled a handle: make sure frames run until its effect has played out. */
  private wake(): void {
    if (this.mode !== 'stopped' || !this.scheduler || !this.assets || this.woken) return;
    this.woken = true;
    this.worldBase = this.assets.visual.position.clone();
    this.scheduler.start();
  }

  /** The chest stands still (settled, or shown as it is): only the world's effects move it. */
  private worldOnly(delta: number): void {
    this.breakageEffects?.update(delta);
    this.applyWorld(delta);
    this.render();
    if (
      this.worldTremor.left <= 0 &&
      this.worldFlash.left <= 0 &&
      delta > 0 &&
      this.breakageEffects?.swinging !== true
    ) {
      if (this.worldBase && this.assets) this.assets.visual.position.copy(this.worldBase);
      this.woken = false;
      this.worldBase = undefined;
      this.scheduler?.stop();
      this.render();
    }
  }

  /** Tremor and light from the world, on top of the pose the chest has this frame. */
  private applyWorld(delta: number): void {
    const visual = this.assets?.visual;
    if (!visual) return;
    // Woken only while standing still; once the chest falls or opens again it drives its own frames.
    if (this.mode !== 'stopped') {
      this.woken = false;
      this.worldBase = undefined;
    } else if (this.worldBase) visual.position.copy(this.worldBase);
    if (this.worldTremor.left > 0) {
      this.worldTremor.left = Math.max(0, this.worldTremor.left - delta);
      const fade = this.worldTremor.left / Math.max(0.001, this.worldTremor.total),
        amount = this.worldTremor.strength * 0.045 * fade;
      visual.position.x += (Math.random() - 0.5) * amount;
      visual.position.z += (Math.random() - 0.5) * amount;
      visual.position.y += Math.random() * amount * 0.4;
    }
    if (this.worldLight) {
      this.worldFlash.left = Math.max(0, this.worldFlash.left - delta);
      this.worldLight.intensity =
        this.worldFlash.peak *
        (this.worldFlash.left / Math.max(0.001, this.worldFlash.total)) ** 1.5;
    }
  }

  private syncPose(): void {
    const pose = this.physics!.readChestPose();
    this.assets!.visual.position.set(pose.position.x, pose.position.y, pose.position.z);
    this.assets!.visual.quaternion.set(
      pose.rotation.x,
      pose.rotation.y,
      pose.rotation.z,
      pose.rotation.w,
    );
  }

  private render(): void {
    // The world draws itself and the chest in it, from its camera.
    this.root.visible = !this.element.hidden;
    this.world?.draw();
  }

  private runtimeFailure(error: unknown): void {
    if (this.disposed) return;
    try {
      this.release();
    } catch (cleanupError) {
      error = new AggregateError([error, cleanupError], 'Scene failure and cleanup error.');
    }
    for (const listener of [...this.errors]) listener(error);
  }

  private release(): void {
    this.entranceTimeline.cancel();
    this.previewEntrance?.cancel();
    this.previewEntrance = undefined;
    this.landing?.cancel(new Error('The chest scene was released.'));
    this.opening?.cancel(new Error('The chest scene was released.'));
    this.mode = 'stopped';
    if (this.mixer && this.assets) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.assets.animationRoot);
    }
    this.mixer = undefined;
    this.generation += 1;
    this.prepared = false;
    this.initialPose = false;
    this.detachAbort?.();
    this.detachAbort = undefined;
    this.scheduler?.dispose();
    this.scheduler = undefined;
    this.fractureEffects?.dispose();
    this.fractureEffects = undefined;
    this.breakageEffects?.dispose();
    this.breakageEffects = undefined;
    this.impactEffects?.dispose();
    this.impactEffects = undefined;
    this.effects?.dispose();
    this.effects = undefined;
    // The body leaves the world's physics; the world itself stays.
    const physics = this.physics,
      assets = this.assets,
      scene = this.scene;
    this.physics = undefined;
    this.assets = undefined;
    this.scene = undefined;
    this.floor = undefined;
    assets?.visual.removeFromParent();
    scene?.removeFromParent();
    const errors: unknown[] = [];
    for (const clean of [
      () => physics?.dispose(),
      () => assets?.dispose(),
      () => {
        if (scene) disposeObject(scene);
      },
    ]) {
      try {
        clean();
      } catch (error) {
        errors.push(error);
      }
    }
    // Still standing in its world: a new preparation makes a new body there.
    this.physics = this.worldPhysics;
    this.stepper.reset();
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to release scene resources.');
  }

  /** Until a world takes the chest in and its physics is ready; a page with no world gives up. */
  private async awaitWorld(signal: AbortSignal): Promise<void> {
    if (this.world && this.worldPhysics) {
      this.physics = this.worldPhysics;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('No world took the chest in.')), WORLD_WAIT_MS);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    try {
      await Promise.race([this.arrival, abort]);
    } finally {
      clearTimeout(timer);
    }
  }

  private assertAlive(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.disposed) throw new Error('The chest scene has been disposed.');
  }

  private assertPrepared(signal: AbortSignal): void {
    this.assertAlive(signal);
    if (!this.prepared) throw new Error('The chest scene is not prepared.');
  }

  private isCurrent(generation: number, signal: AbortSignal): boolean {
    return !this.disposed && !signal.aborted && this.generation === generation;
  }
}
