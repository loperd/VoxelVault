import { ACESFilmicToneMapping, PMREMGenerator, SRGBColorSpace, Timer, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { ItemInspection } from '../../../application/ports/item-presentation.ts';
import type { ItemState } from '../../../domain/case-instance.ts';
import { createItemStage, type ItemStage } from './item-stage.ts';

/** Seconds after the player lets go before the model turns by itself again. */
const RESUME_TURN = 3;

/**
 * One item to turn and inspect: drag (mouse or one finger) orbits, wheel or pinch zooms, `reset()`
 * returns to the first view. Its own WebGL context, so one at a time per screen; it draws only while on
 * screen and the page is visible, and stops animating for reduced motion (then it draws on input only).
 */
export class ItemViewer implements ItemInspection {
  private readonly host: HTMLElement;
  private readonly renderer: WebGLRenderer;
  private readonly abort = new AbortController();
  private readonly timer = new Timer();
  private readonly motion: MediaQueryList;
  private stage?: ItemStage;
  private controls?: OrbitControls;
  private resize?: ResizeObserver;
  private visibility?: IntersectionObserver;
  private onScreen = true;
  private frame = 0;
  private idleFor = RESUME_TURN;
  private dragging = false;
  private readonly onPage = () => this.schedule();

  constructor(
    host: HTMLElement,
    baseUrl: URL,
    itemId: string,
    options: { readonly condition?: ItemState; readonly onReady?: () => void } = {},
  ) {
    this.host = host;
    const view = host.ownerDocument.defaultView!;
    this.motion = view.matchMedia('(prefers-reduced-motion: reduce)');
    this.renderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
    });
    this.renderer.setClearColor(0, 0);
    this.renderer.setPixelRatio(Math.min(2, view.devicePixelRatio || 1));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    const canvas = this.renderer.domElement;
    canvas.className = 'item-viewer__canvas';
    // The page must not scroll or zoom under a finger turning the model.
    canvas.style.touchAction = 'none';
    host.append(canvas);
    const pmrem = new PMREMGenerator(this.renderer),
      environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    void createItemStage(baseUrl, itemId, this.abort.signal, {
      condition: options.condition,
      environment,
    })
      .then((stage) => {
        if (this.abort.signal.aborted) {
          stage.dispose();
          return;
        }
        this.stage = stage;
        this.renderer.toneMappingExposure = stage.exposure;
        const controls = (this.controls = new OrbitControls(stage.camera, canvas));
        controls.enablePan = false;
        controls.minDistance = stage.bounds.radius * 1.4;
        controls.maxDistance = stage.bounds.radius * 6;
        controls.addEventListener('start', () => {
          this.dragging = true;
          this.idleFor = 0;
          controls.autoRotate = false;
        });
        controls.addEventListener('end', () => {
          this.dragging = false;
        });
        controls.addEventListener('change', () => this.schedule());
        this.layout();
        this.applyMotion();
        controls.target.copy(stage.bounds.center);
        controls.update();
        controls.saveState();
        this.resize = new ResizeObserver(() => {
          this.layout();
          this.schedule();
        });
        this.resize.observe(host);
        this.visibility = new IntersectionObserver(([entry]) => {
          this.onScreen = !!entry?.isIntersecting;
          this.schedule();
        });
        this.visibility.observe(host);
        this.motion.addEventListener('change', this.onMotion);
        host.ownerDocument.addEventListener('visibilitychange', this.onPage);
        this.draw(0);
        options.onReady?.();
        this.schedule();
      }) // The still under the viewer stays as the picture; the failure is still worth seeing.
      .catch((error) => {
        if (!this.abort.signal.aborted) console.error('The item viewer failed.', error);
      })
      .finally(() => environment.dispose());
  }

  reset(): void {
    if (!this.controls) return;
    this.controls.reset();
    this.idleFor = RESUME_TURN;
    this.applyMotion();
    this.schedule();
  }

  dispose(): void {
    this.abort.abort();
    this.host.ownerDocument.defaultView?.cancelAnimationFrame(this.frame);
    this.host.ownerDocument.removeEventListener('visibilitychange', this.onPage);
    this.motion.removeEventListener('change', this.onMotion);
    this.resize?.disconnect();
    this.visibility?.disconnect();
    this.controls?.dispose();
    this.stage?.dispose();
    // Freed now, not when the garbage collector finds the context: phones hold only a few.
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private readonly onMotion = () => {
    this.applyMotion();
    this.schedule();
  };

  private get still(): boolean {
    return this.motion.matches;
  }

  private applyMotion(): void {
    if (!this.controls) return;
    // Damping and the turntable both need frames after the input ends; reduced motion keeps neither.
    this.controls.enableDamping = !this.still;
    this.controls.autoRotate = !this.still && this.idleFor >= RESUME_TURN;
  }

  private layout(): void {
    const width = Math.max(1, this.host.clientWidth),
      height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    if (!this.stage || !this.controls) return;
    // Keep where the player turned it, only refit the lens to the new shape.
    const camera = this.stage.camera,
      offset = camera.position.clone().sub(this.controls.target);
    this.stage.frame(width / height);
    if (this.controls.position0.lengthSq() > 0)
      camera.position.copy(this.controls.target).add(offset);
    camera.updateProjectionMatrix();
  }

  private schedule(): void {
    const view = this.host.ownerDocument.defaultView;
    if (!view || this.frame || !this.stage || this.abort.signal.aborted) return;
    if (!this.onScreen || this.host.ownerDocument.hidden) return;
    this.frame = view.requestAnimationFrame((time) => {
      this.frame = 0;
      this.tick(time);
    });
  }

  private tick(time: number): void {
    this.timer.update(time);
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.draw(this.still ? 0 : dt);
    // Reduced motion draws on input only; otherwise the model lives while it is watched.
    if (!this.still) this.schedule();
  }

  private draw(dt: number): void {
    const stage = this.stage,
      controls = this.controls;
    if (!stage || !controls) return;
    if (
      !controls.autoRotate &&
      !this.still &&
      !this.dragging &&
      (this.idleFor += dt) >= RESUME_TURN
    )
      controls.autoRotate = true;
    stage.update(dt);
    controls.update(dt);
    this.renderer.render(stage.scene, stage.camera);
  }
}
