import {
  ACESFilmicToneMapping,
  BackSide,
  DirectionalLight,
  Group,
  HemisphereLight,
  OrthographicCamera,
  PCFShadowMap,
  PCFSoftShadowMap,
  PlaneGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  type Camera,
  type ToneMapping,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Fog,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NoToneMapping,
  PerspectiveCamera,
  PointLight,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Object3D,
  type Texture,
} from 'three';
import type { MeshArrays, WorldMesh } from './mesher.ts';
import { raw } from './color.ts';
import { WorldPhysics, type PhysicsGround, type Vec } from './physics.ts';
import { flickerBeat, LOCAL_BUDGET, type LightingPreset, type StageLighting } from './lighting.ts';

/**
 * Shows a block world: one renderer, a sky dome and fog, a slowly drifting camera, and the stage's
 * living things updated each frame. Built stages are cached for the session. It renders at a reduced
 * resolution, ~30 frames a second, and gives up quality before frames: resolution, then frame rate,
 * then a still picture. Paused while the page is hidden or the user prefers reduced motion.
 *
 * `H` is whatever the host lets the world act on (the app passes its own handles); the library
 * never looks inside it.
 */
export interface StageContext<H> {
  readonly time: number;
  /** Current wind, -1..1. */
  readonly wind: number;
  readonly rand: () => number;
  readonly host: H | undefined;
  /** A gust: the wind rises for a moment. */
  gust(strength: number, side: number): void;
  /** The world flashes (lightning): sky and fog light up for a moment. */
  flash(color: string, strength: number): void;
  /** A blast: bodies in the world's physics (a guest's, say) are thrown away from the point. */
  blast(at: Vec, strength: number, radius: number): void;
}

export interface Living<H> {
  update(context: StageContext<H>, dt: number): void;
}

export interface Stage<H> {
  readonly root: Object3D;
  /**
   * Things in standard colour — glTF models: sRGB textures, linear factors, lit materials. They are
   * drawn after the blocks, in the world's depth, in a pass of their own that writes sRGB (docs §4.2):
   * the blocks' pass shows colours as computed, where these would show their linear values, too dark.
   */
  readonly objects?: Object3D;
  readonly living: readonly Living<H>[];
  readonly sky: { readonly top: string; readonly horizon: string; readonly bottom: string };
  readonly fog: { readonly color: string; readonly near: number; readonly far: number };
  readonly camera: {
    readonly position: readonly [number, number, number];
    readonly target: readonly [number, number, number];
    readonly fov?: number;
    readonly drift?: number;
    /** Where on the screen the target shows, as fractions of width and height (default the middle). */
    readonly focus?: readonly [number, number];
  };
  readonly calm?: number;
  /**
   * The block guests stand on (see `Guest`): the point on top of it where their floor (y 0) goes.
   * Without it the world takes no guests.
   */
  readonly anchor?: readonly [number, number, number];
  /** No sky and a see-through canvas: only guests and whatever the stage holds are drawn. */
  readonly transparent?: boolean;
  /** What bodies in the world's physics stand on: its blocks around the anchor, or a flat floor. */
  readonly ground?: PhysicsGround;
  /**
   * The sun as the sky and the shaders see it: a halo around it, haze that glows towards it, water
   * glinting with it, leaves lit through. Direction towards the sun; leave out for none (night, caves).
   */
  readonly sun?: {
    readonly direction: readonly [number, number, number];
    readonly color: string;
    readonly scatter?: number;
  };
  /** How strongly torchlight flickers, 0..~.2 (default .08). */
  readonly flicker?: number;
  /** The light guests are lit with here: from above, from below, and the main light's colour. */
  readonly light?: GuestLight;
  /** The way a guest on the anchor faces, along the ground (x, z). Default: towards the camera. */
  readonly anchorFront?: readonly [number, number];
  /** One multiplier of light on surfaces (default 1): blocks in their shader, guests through their exposure. */
  readonly exposure?: number;
  /** Local lights for the guests' pass (world coordinates, guest units); the view gives them point lights. */
  readonly locals?: StageLighting['locals'];
  /** The name of the lighting preset shown; undefined while the stage shows its own light. */
  readonly lighting?: string;
  /**
   * Light the stage another way — a preset, or undefined for its own light again — keeping all else:
   * afterwards its sky, fog, sun, flicker, light, exposure and locals read the new light, and its
   * meshes and objects show it (see BlockView.setLighting).
   */
  relight?(preset: LightingPreset | undefined): void;
  /**
   * Frees what this stage alone owns (its meshes, its copies of materials), never what it borrows.
   * Called by the view for a builder with `cache: false`; calling it again does nothing.
   */
  dispose?(): void;
}

export interface GuestLight {
  readonly sky: string;
  readonly ground: string;
  readonly key: string;
  /**
   * Where the key comes from: a direction towards it, in world space — say from the anchor to the
   * glowing block that lights the scene, so blocks and guest are lit by one light. Default: the
   * guest's own direction.
   */
  readonly from?: readonly [number, number, number];
  /** How strong the key and the sky/ground fill are, in the guest's light units (default its own). */
  readonly keyStrength?: number;
  readonly fillStrength?: number;
}

/**
 * The world's key light as a position for a guest's own directional light: in the guest's frame
 * (the world turned it by `turn` about the vertical), `distance` of the guest's units away.
 * Undefined when the world does not say where its key is.
 */
export function guestKey(
  world: Pick<GuestWorld, 'light' | 'turn'>,
  distance: number,
): [number, number, number] | undefined {
  const from = world.light?.from;
  if (!from) return undefined;
  const length = Math.hypot(from[0], from[1], from[2]) || 1,
    c = Math.cos(-world.turn),
    s = Math.sin(-world.turn);
  const [x, y, z] = [from[0] / length, from[1] / length, from[2] / length];
  return [(x * c + z * s) * distance, y * distance, (-x * s + z * c) * distance];
}

export interface StageBuilder<H> {
  readonly id: string;
  build(seed: number): Stage<H>;
  /**
   * false: every view builds a stage of its own and frees it when it goes (world packs). Default: the
   * stage is built once and cached for the session, one view at a time.
   */
  readonly cache?: boolean;
}
export type GraphicsMode = 'baseline' | 'shadow-poc';
export interface BlockRenderMetrics {
  readonly mode: GraphicsMode;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly frameMs: number;
  readonly fps: number;
  readonly shadowMap: boolean;
}

/**
 * Something from outside that lives in the world — a chest, say. The world is the base: it stands
 * the guest on its anchor block, draws it with its own camera after the world itself, sharing the
 * depth (so grass in front of it hides it and it hides what is behind), and its camera is the one
 * that moves in on it. The guest brings its own things, units, lights and look; it moves on its
 * own (physics, animations) and asks the world to draw when it did.
 */
export interface Guest {
  /** The guest's things, in its own units, its floor at y 0 and its middle over x 0, z 0. */
  readonly root: Object3D;
  /** How many of its units make one block. */
  readonly unit: number;
  /** The side it shows the viewer, a direction along its ground (x, z); the world turns it so. */
  readonly front?: readonly [number, number];
  /** Its own look: lit materials, a film curve, shadows, clipping planes. The world's look is untouched. */
  readonly look?: {
    readonly toneMapping?: ToneMapping;
    readonly exposure?: number;
    readonly srgb?: boolean;
    readonly shadows?: boolean;
    readonly clipping?: boolean;
  };
  /** The world took the guest in; it may now ask for frames and move the camera. */
  enter?(world: GuestWorld): void;
  /** The world let it go (or went away). */
  leave?(): void;
  /** The world's light changed: `world.light` now reads the new one. */
  relight?(): void;
}

export interface GuestWorld {
  /** Draw now: the guest moved. */
  draw(): void;
  /** Move the camera in on the guest: `closer` 0 at home .. 1 at it; `lift` raises the aim, in blocks. */
  approach(closer: number, lift?: number): void;
  /** The guest alone on a clear background, seen by another camera (in world units), as a PNG. */
  picture(camera: Camera, width: number, height: number): string;
  /** The world's camera, to see from the way the world does. */
  readonly camera: PerspectiveCamera;
  /** The world's physics: the guest's body goes in here; the world's ground and blasts act on it. */
  readonly physics: Promise<WorldPhysics>;
  /** Bring the world's physics up to now (a guest drawing its own frames calls this first). */
  sync(): void;
  /** Where the guest's floor stands in the world (its physics is in world coordinates). */
  readonly anchor: Vec;
  /** How the world turned the guest about the vertical (radians) to show its front. */
  readonly turn: number;
  /** The world's light, for the guest to light itself with (none: its own); read it again on `relight`. */
  readonly light?: GuestLight;
}

/**
 * What the shaders know about the world: its clock, the wind, the sun (where it hangs and its
 * colour), the sky at the horizon. One set for the page; the view that draws fills it in before each
 * frame, and the materials read it on the GPU — the whole layer costs no work on the CPU.
 */
const atmosphere = {
  time: { value: 0 },
  wind: { value: 0 },
  sunDirection: { value: new Vector3(0, 1, 0) },
  sunColor: { value: new Color(0, 0, 0) },
  horizon: { value: new Color(1, 1, 1) },
  scatter: { value: 0 },
  flicker: { value: 0 },
  exposure: { value: 1 },
};

const VERTEX_HEAD = `#include <common>
attribute float sway;
attribute float glow;
uniform float time;
uniform float wind;
varying vec3 vWorld;
varying float vSway;
varying float vGlow;`;

const FRAGMENT_HEAD = `#include <common>
uniform float time;
uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform vec3 horizon;
uniform float scatter;
uniform float flicker;
uniform float exposure;
varying vec3 vWorld;
varying float vSway;
varying float vGlow;`;

/** Plants and leaves bend with the wind; their roots (sway 0) stay put. */
const SWAY = `#include <begin_vertex>
float phase = position.x * .63 + position.z * .41;
float push = sin(time * 1.7 + phase) * .055 + sin(time * 3.1 + phase * 2.3) * .02 + wind * .14;
transformed.x += sway * push;
transformed.z += sway * (cos(time * 1.3 + phase * 1.4) * .04 + wind * .05);`;

/** A liquid's surface rolls in two crossing swells. */
const WAVE = `#include <begin_vertex>
transformed.y += sway * (sin(time * 1.2 + position.x * .8 + position.z * .3) * .045 + sin(time * 1.9 - position.z * 1.1) * .025 - .03);`;

const VARYINGS = `
vWorld = (modelMatrix * vec4(transformed, 1.)).xyz;
vSway = sway;
vGlow = glow;`;

/**
 * Light the vanilla colours can't hold: torchlight breathes (each torch to its own beat), leaves
 * and grass glow through when the sun is behind them.
 */
const LIGHT = `vec3 look = normalize(vWorld - cameraPosition);
float toSun = max(dot(look, sunDirection), 0.);
float beat = sin(time * 7.3 + floor(vWorld.x * .25) * 1.9 + floor(vWorld.z * .25) * 2.7) * .6 + sin(time * 13.1 + vWorld.x) * .4;
gl_FragColor.rgb *= 1. + vGlow * flicker * beat;
gl_FragColor.rgb += gl_FragColor.rgb * sunColor * min(vSway, 1.) * pow(toSun, 4.) * .55;
gl_FragColor.rgb *= exposure;`;

/**
 * Water as shader packs draw it: a rippled surface that reflects the horizon at grazing angles and
 * throws back sparks of sun where a ripple faces it.
 */
const WATER = `float rx = cos(vWorld.x * 1.7 + time * 1.4) * sin(vWorld.z * 1.3 - time * 1.1) + cos((vWorld.x + vWorld.z) * .9 - time * .8) * .5;
float rz = sin(vWorld.x * 1.7 + time * 1.4) * cos(vWorld.z * 1.3 - time * 1.1) + cos((vWorld.x + vWorld.z) * .9 - time * .8) * .5;
vec3 ripple = normalize(vec3(rx * .12, 1., rz * .12)); // lit materials already declare normal
float fresnel = pow(1. - abs(dot(look, ripple)), 3.);
gl_FragColor.rgb = mix(gl_FragColor.rgb, horizon, fresnel * .6);
float glint = pow(max(dot(reflect(look, ripple), sunDirection), 0.), 80.);
gl_FragColor.rgb += sunColor * glint * 1.4;
gl_FragColor.a = min(1., gl_FragColor.a + fresnel * .3 + glint);`;

/** Fog that catches the sun: towards it, the haze glows in the sun's colour. */
const FOG = `#ifdef USE_FOG
float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
// Shafts: the haze towards the sun is striped by angle around the sun's axis, as light through gaps in the clouds.
vec3 rayAxis = abs(sunDirection.y) > .9 ? vec3(1., 0., 0.) : vec3(0., 1., 0.);
vec3 rayX = normalize(cross(sunDirection, rayAxis));
float rayAng = atan(dot(look, cross(sunDirection, rayX)), dot(look, rayX));
float shaft = .25 + .75 * (.5 + .5 * sin(rayAng * 13. + sin(rayAng * 5. + time * .12) * 1.6));
vec3 haze = mix(fogColor, sunColor, min(pow(toSun, 6.) * scatter * (.35 + shaft), 1.));
gl_FragColor.rgb = mix(gl_FragColor.rgb, haze, fogFactor);
#endif`;

/** A pack's relief and material maps, laid out like its atlas: normals (OpenGL, green up) and MER (R metalness, G emissive, B roughness). */
export interface Pbr {
  readonly normal: Texture;
  readonly material: Texture;
}

const PBR_HEAD = `uniform sampler2D pbrNormal;
uniform sampler2D pbrMer;`;

/**
 * Relief and sheen over the baked light: the normal map bends the tile's shading against the sun, metal
 * and smooth tiles take a highlight (only where the baked light says the sun reaches), emissive tiles
 * glow on their own. Faces are axis-aligned, so the tangent frame comes from screen derivatives.
 */
const PBR = `{
vec3 dp1 = dFdx(vWorld), dp2 = dFdy(vWorld);
vec2 du1 = dFdx(vMapUv), du2 = dFdy(vMapUv);
vec3 gN = normalize(cross(dp1, dp2));
vec3 eye = normalize(vWorld - cameraPosition);
if (dot(gN, eye) > 0.) gN = -gN;
vec3 perp2 = cross(dp2, gN), perp1 = cross(gN, dp1);
vec3 tan = perp2 * du1.x + perp1 * du2.x;
vec3 bit = perp2 * du1.y + perp1 * du2.y;
float scale = inversesqrt(max(max(dot(tan, tan), dot(bit, bit)), 1e-12));
vec3 n = normalize(mat3(tan * scale, bit * scale, gN) * (texture2D(pbrNormal, vMapUv).xyz * 2. - 1.));
vec3 mer = texture2D(pbrMer, vMapUv).rgb;
vec3 albedo = texture2D(map, vMapUv).rgb;
vec3 sunWay = dot(sunColor, vec3(1.)) > 0. ? normalize(sunDirection) : normalize(vec3(.3, .8, .5));
float relief = clamp((dot(n, sunWay) + .6) / (max(dot(gN, sunWay), 0.) + .6), .45, 1.6);
gl_FragColor.rgb *= mix(1., relief, .75);
float rough = max(mer.b, .04);
float sunReach = clamp(dot(vColor.rgb, vec3(.333)) * 1.6, 0., 1.);
float shine = pow(max(dot(normalize(mix(gN, n, .35)), normalize(sunWay - eye)), 0.), mix(3., 28., (1. - rough) * (1. - rough)));
gl_FragColor.rgb *= 1. - mer.r * .3;
gl_FragColor.rgb += (sunColor + .08) * mix(vec3(.04), albedo, mer.r) * shine * (1. - rough) * sunReach * 1.1;
gl_FragColor.rgb += albedo * mer.g * 1.2;
// The sky in smooth surfaces: the horizon's colour, dimmer toward the ground, strongest at grazing angles and on metal; dark where the baked light says it is closed in.
vec3 mirror = reflect(eye, n);
float fresnel = pow(1. - max(dot(n, -eye), 0.), 4.);
gl_FragColor.rgb += mix(horizon * .3, horizon, clamp(mirror.y * .5 + .5, 0., 1.)) * (mer.r * .16 + (1. - rough) * fresnel * .22) * sunReach;
}`;

export function moving<T extends MeshBasicMaterial | MeshLambertMaterial>(
  material: T,
  kind: 'sway' | 'wave',
  pbr?: Pbr,
): T {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, atmosphere);
    if (pbr) {
      shader.uniforms.pbrNormal = { value: pbr.normal };
      shader.uniforms.pbrMer = { value: pbr.material };
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERTEX_HEAD)
      .replace('#include <begin_vertex>', [kind === 'sway' ? SWAY : WAVE, VARYINGS].join('\n'));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', pbr ? `${FRAGMENT_HEAD}\n${PBR_HEAD}` : FRAGMENT_HEAD)
      .replace(
        '#include <fog_fragment>',
        [pbr ? PBR : '', LIGHT, kind === 'wave' ? WATER : '', FOG].join('\n'),
      );
  };
  material.customProgramCacheKey = () => `blockworld-${kind}${pbr ? '-pbr' : ''}`;
  return material;
}

/** The three materials of a meshed world, sharing one atlas (the solid blocks also take its PBR maps). */
export function worldMeshes(mesh: WorldMesh, atlas: Texture, pbr?: Pbr): Mesh[] {
  const opaque = new Mesh(
    geometry(mesh.opaque),
    moving(new MeshBasicMaterial({ map: atlas, vertexColors: true, alphaTest: 0.5 }), 'sway', pbr),
  );
  const plants = new Mesh(
    geometry(mesh.plants),
    moving(
      new MeshBasicMaterial({ map: atlas, vertexColors: true, alphaTest: 0.5, side: DoubleSide }),
      'sway',
    ),
  );
  const liquid = new Mesh(
    geometry(mesh.liquid),
    moving(
      new MeshBasicMaterial({
        map: atlas,
        vertexColors: true,
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
        side: DoubleSide,
      }),
      'wave',
    ),
  );
  opaque.userData.blockworldPass = 'sway';
  plants.userData.blockworldPass = 'sway';
  liquid.userData.blockworldPass = 'wave';
  liquid.renderOrder = 1;
  return [opaque, plants, liquid].filter((part) => (part.geometry.index?.count ?? 0) > 0);
}

export function geometry(arrays: MeshArrays): BufferGeometry {
  const result = new BufferGeometry();
  result.setAttribute('position', new BufferAttribute(arrays.positions, 3));
  result.setAttribute('uv', new BufferAttribute(arrays.uvs, 2));
  result.setAttribute('color', new BufferAttribute(arrays.colors, 3));
  const empty = () => new Float32Array(arrays.positions.length / 3);
  result.setAttribute('sway', new BufferAttribute(arrays.sway ?? empty(), 1));
  result.setAttribute('glow', new BufferAttribute(arrays.glow ?? empty(), 1));
  result.setIndex(new BufferAttribute(arrays.indices, 1));
  result.computeBoundingSphere();
  return result;
}

const FPS = 30,
  MIN_FPS = 20;
const AIM = new Vector3();
const stages = new Map<string, Stage<unknown>>();

/** Build a stage ahead of time; later views reuse it instantly. A stage that is not cached is not built. */
export function preloadStage<H>(builder: StageBuilder<H>, seed = 1): void {
  if (builder.cache !== false) stageOf(builder, seed);
}

function stageOf<H>(builder: StageBuilder<H>, seed: number): Stage<H> {
  if (builder.cache === false) return builder.build(seed);
  const key = `${builder.id}:${seed}`;
  let stage = stages.get(key) as Stage<H> | undefined;
  if (!stage) {
    stage = builder.build(seed);
    stages.set(key, stage as Stage<unknown>);
  }
  return stage;
}

/** The dome's colours: the horizon blending to the top above and the bottom below. */
function paintSky(dome: BufferGeometry, sky: Stage<unknown>['sky']): void {
  const colors: number[] = [];
  const top = raw(sky.top),
    horizon = raw(sky.horizon),
    bottom = raw(sky.bottom),
    c = new Color();
  const position = dome.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const h = position.getY(i) / 900;
    if (h >= 0) c.copy(horizon).lerp(top, Math.pow(h, 0.55));
    else c.copy(horizon).lerp(bottom, Math.min(1, -h * 3));
    colors.push(c.r, c.g, c.b);
  }
  // Painted again in place: a new attribute would leave the old one's GPU buffer behind.
  const painted = dome.getAttribute('color');
  if (painted) {
    (painted.array as Float32Array).set(colors);
    painted.needsUpdate = true;
  } else dome.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
}

function skyDome(sky: Stage<unknown>['sky']): Mesh {
  const dome = new SphereGeometry(900, 24, 16);
  paintSky(dome, sky);
  const material = new MeshBasicMaterial({
    vertexColors: true,
    side: BackSide,
    fog: false,
    depthWrite: false,
  });
  // The sun's halo: a tight bright core and a wide soft glow, as the game's sunset sky.
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, atmosphere);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDirection;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvDirection = normalize(position);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 sunDirection;\nuniform vec3 sunColor;\nvarying vec3 vDirection;',
      )
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
float toSun = max(dot(normalize(vDirection), sunDirection), 0.);
gl_FragColor.rgb += sunColor * (pow(toSun, 90.) * .8 + pow(toSun, 12.) * .28 + pow(toSun, 3.) * .1);`,
      );
  };
  material.customProgramCacheKey = () => 'blockworld-sky';
  return new Mesh(dome, material);
}

export class BlockView<H> {
  readonly canvas: HTMLCanvasElement;
  private readonly view: Window;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  /** The stage's objects, drawn in standard colour after the blocks (see Stage.objects). */
  private readonly objectScene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly stage: Stage<H>;
  /** The view built the stage for itself (`cache: false`) and frees it. */
  private readonly ownsStage: boolean;
  private readonly dome: Mesh;
  private readonly fog: Fog;
  /** The same fog for the objects' pass, its colour taken from sRGB to the linear values that pass works in. */
  private readonly objectFog: Fog;
  private readonly fogBase: Color;
  private readonly sunLight: DirectionalLight;
  private readonly fillLight: HemisphereLight;
  private graphicsMode: GraphicsMode = 'baseline';
  private readonly shadowMaterials: {
    mesh: Mesh;
    baseline: MeshBasicMaterial;
    experiment: MeshLambertMaterial;
  }[] = [];
  private metrics: BlockRenderMetrics = {
    mode: 'baseline',
    drawCalls: 0,
    triangles: 0,
    geometries: 0,
    textures: 0,
    frameMs: 0,
    fps: 0,
    shadowMap: false,
  };
  private fpsWindow = 0;
  private fpsFrames = 0;
  private frameMsSum = 0;
  private frameSamples = 0;
  private sceneMs = 0;
  private readonly flashColor = new Color();
  private readonly target = new Vector3();
  /** Where the camera stands when a page has moved it (`aim`), instead of the stage's place. */
  private eye?: readonly [number, number, number];
  private host: H | undefined;
  private readonly guests = new Map<Guest, Group>();
  /** A darkening laid over the world but under the guests (an interface reads over it). */
  private readonly veil?: {
    readonly scene: Scene;
    readonly camera: OrthographicCamera;
    readonly material: ShaderMaterial;
  };
  private readonly guestScene = new Scene();
  /** Point lights for the stage's locals in the guests' pass: none, or always LOCAL_BUDGET (unused ones dark), so a relight compiles nothing. */
  private readonly guestLocals: PointLight[] = [];
  private closer = 0;
  private lift = 0;
  private lastDrawn = 0;
  private withoutGuests = false;
  private physicsWorld?: WorldPhysics;
  private physicsLoad?: Promise<WorldPhysics>;
  private time = 0;
  private wind = 0;
  private gustLevel = 0;
  private gustSide = 1;
  private flashLevel = 0;
  private running = false;
  private active = true;
  private disposed = false;
  private frame = 0;
  private last = 0;
  private fps = FPS;
  private quality: number;
  private slow = 0;
  private readonly rand: () => number;
  private readonly motion: MediaQueryList;
  private readonly onChange = () => this.sync();
  private readonly resizeObserver?: ResizeObserver;

  /**
   * `veil`: darkness laid over the world, under its guests, as alphas at the top, middle (42%) and
   * bottom of the view, so an interface on top stays readable without dimming the guests.
   */
  constructor(
    element: HTMLElement,
    builder: StageBuilder<H>,
    options: {
      seed?: number;
      veil?: { color: string; top: number; middle: number; bottom: number; side?: number };
      graphicsMode?: GraphicsMode;
    } = {},
  ) {
    this.view = element.ownerDocument.defaultView ?? window;
    this.stage = stageOf(builder, options.seed ?? 1);
    this.ownsStage = builder.cache === false;
    // A cached stage's root is one object: shown by a second view it would silently leave the first.
    if (this.stage.root.parent || this.stage.objects?.parent) {
      if (this.ownsStage) this.stage.dispose?.();
      throw new Error(
        `The world "${builder.id}" is already shown by another view; a cached stage is shown by one view at a time.`,
      );
    }
    try {
      let state = ((options.seed ?? 1) * 9301 + 49297) % 233280;
      this.rand = () => {
        state = (state * 9301 + 49297) % 233280;
        return state / 233280;
      };
      this.renderer = new WebGLRenderer({
        antialias: false,
        alpha: this.stage.transparent === true,
        powerPreference: 'low-power',
        stencil: false,
      });
      this.renderer.info.autoReset = false;
      if (this.stage.transparent) this.renderer.setClearColor(0x000000, 0);
      // The game's look: colours go to the screen as computed, no colour management, no tone curve.
      this.renderer.outputColorSpace = LinearSRGBColorSpace;
      this.renderer.toneMapping = NoToneMapping;
      this.quality = Math.min(1, (this.view.devicePixelRatio || 1) * 0.75);
      this.renderer.setPixelRatio(this.quality);
      this.canvas = this.renderer.domElement;
      Object.assign(this.canvas.style, {
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
      });
      this.canvas.setAttribute('aria-hidden', 'true');
      element.prepend(this.canvas);
      this.camera = new PerspectiveCamera(this.stage.camera.fov ?? 70, 16 / 9, 0.1, 1200);
      this.fogBase = raw(this.stage.fog.color);
      this.fog = new Fog(this.fogBase.clone(), this.stage.fog.near, this.stage.fog.far);
      this.dome = skyDome(this.stage.sky);
      this.objectFog = new Fog(this.fogBase.clone(), this.stage.fog.near, this.stage.fog.far);
      if (!this.stage.transparent) {
        this.scene.fog = this.fog;
        this.objectScene.fog = this.objectFog;
        this.scene.add(this.dome);
      }
      this.scene.add(this.stage.root);
      if (this.stage.objects) this.objectScene.add(this.stage.objects);
      const focus = this.stage.camera.target,
        direction = this.stage.sun?.direction ?? [-0.4, 0.7, -0.5];
      this.sunLight = new DirectionalLight(this.stage.sun?.color ?? '#ffd19a', 2.1);
      this.sunLight.castShadow = true;
      this.sunLight.shadow.mapSize.set(1536, 1536);
      this.sunLight.shadow.camera.left = -48;
      this.sunLight.shadow.camera.right = 48;
      this.sunLight.shadow.camera.top = 42;
      this.sunLight.shadow.camera.bottom = -42;
      this.sunLight.shadow.camera.near = 0.5;
      this.sunLight.shadow.camera.far = 220;
      this.sunLight.shadow.bias = -0.0002;
      this.sunLight.shadow.normalBias = 0.025;
      this.sunLight.shadow.radius = 3;
      this.sunLight.position.set(
        focus[0] + direction[0] * 90,
        focus[1] + direction[1] * 90,
        focus[2] + direction[2] * 90,
      );
      this.sunLight.target.position.set(...focus);
      this.sunLight.visible = false;
      this.sunLight.target.visible = false;
      this.fillLight = new HemisphereLight('#f2e4cc', '#354052', 1.15);
      this.fillLight.visible = false;
      this.scene.add(this.sunLight, this.sunLight.target, this.fillLight);
      this.target.set(...this.stage.camera.target);
      this.syncLocals();
      if (options.veil) {
        const { color, top, middle, bottom, side = 0 } = options.veil;
        const material = new ShaderMaterial({
          transparent: true,
          depthTest: false,
          depthWrite: false,
          uniforms: {
            color: { value: raw(color) },
            top: { value: top },
            middle: { value: middle },
            bottom: { value: bottom },
            side: { value: side },
          },
          vertexShader:
            'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
          // `side` darkens the left and right edges (where the heading and the featured find sit), fading out by 30% in.
          fragmentShader: `uniform vec3 color; uniform float top; uniform float middle; uniform float bottom; uniform float side; varying vec2 vUv;
  void main() { float down = 1. - vUv.y; float a = down < .42 ? mix(top, middle, down / .42) : mix(middle, bottom, (down - .42) / .58);
  float edge = smoothstep(.3, 0., min(vUv.x, 1. - vUv.x)); a = 1. - (1. - a) * (1. - side * edge); gl_FragColor = vec4(color, a); }`,
        });
        const scene = new Scene();
        scene.add(new Mesh(new PlaneGeometry(2, 2), material));
        this.veil = { scene, camera: new OrthographicCamera(), material };
      }
      this.motion = this.view.matchMedia('(prefers-reduced-motion: reduce)');
      this.motion.addEventListener('change', this.onChange);
      element.ownerDocument.addEventListener('visibilitychange', this.onChange);
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(element);
      }
      this.resize();
      this.setGraphicsMode(options.graphicsMode ?? 'baseline');
      this.sync();
    } catch (error) {
      // Nothing of a view that never opened may stay: the root leaves the scene (or the world could
      // never be shown again) and the view's own stage is freed.
      this.disposed = true;
      this.scene.remove(this.stage.root);
      if (this.stage.objects) this.objectScene.remove(this.stage.objects);
      if (this.ownsStage) this.stage.dispose?.();
      // Whatever of the view's own was made before the failure (fields not yet set are undefined).
      const made = this as unknown as {
        canvas?: HTMLCanvasElement;
        renderer?: WebGLRenderer;
        motion?: MediaQueryList;
        resizeObserver?: ResizeObserver;
      };
      made.motion?.removeEventListener('change', this.onChange);
      element.ownerDocument.removeEventListener('visibilitychange', this.onChange);
      made.resizeObserver?.disconnect();
      made.renderer?.dispose();
      made.canvas?.remove();
      throw error;
    }
  }

  /** Dev-only A/B switch: same block meshes, with dynamic Lambert lighting and shadow maps. */
  setGraphicsMode(mode: GraphicsMode): void {
    if (this.disposed || this.graphicsMode === mode) return;
    this.graphicsMode = mode;
    this.fpsWindow = 0;
    this.fpsFrames = 0;
    this.frameMsSum = 0;
    this.frameSamples = 0;
    this.metrics = { ...this.metrics, mode, frameMs: 0, fps: 0, shadowMap: mode === 'shadow-poc' };
    if (mode === 'shadow-poc') {
      this.stage.root.traverse((object) => {
        if (
          !(object instanceof Mesh) ||
          !object.userData.blockworldPass ||
          !(object.material instanceof MeshBasicMaterial)
        )
          return;
        const baseline = object.material,
          kind = object.userData.blockworldPass as 'sway' | 'wave';
        object.geometry.computeVertexNormals();
        const experiment = moving(
          new MeshLambertMaterial({
            map: baseline.map,
            vertexColors: true,
            alphaTest: baseline.alphaTest,
            transparent: baseline.transparent,
            opacity: baseline.opacity,
            depthWrite: baseline.depthWrite,
            side: baseline.side,
            fog: baseline.fog,
          }),
          kind,
        );
        this.shadowMaterials.push({ mesh: object, baseline, experiment });
        object.material = experiment;
        object.castShadow = true;
        object.receiveShadow = true;
      });
      this.sunLight.visible = true;
      this.sunLight.target.visible = true;
      this.fillLight.visible = true;
    } else {
      for (const entry of this.shadowMaterials) {
        entry.mesh.material = entry.baseline;
        entry.mesh.castShadow = false;
        entry.mesh.receiveShadow = false;
        entry.experiment.dispose();
      }
      this.shadowMaterials.length = 0;
      this.sunLight.visible = false;
      this.sunLight.target.visible = false;
      this.fillLight.visible = false;
    }
    this.draw();
  }

  /**
   * Light the world with a preset, or undefined for the stage's own light, without a new view: the
   * stage re-lights its blocks and objects, the view its sky, fog, atmosphere and the guests' local
   * lights, and the guests are told (`Guest.relight`). Only stages that can be relit (world packs).
   */
  setLighting(preset: LightingPreset | undefined): void {
    if (this.disposed) return;
    if (!this.stage.relight)
      throw new Error('This world cannot be relit: lighting presets are for world packs.');
    // The shadow experiment holds copies of the block materials; it is set up again on the new meshes.
    const mode = this.graphicsMode;
    if (mode !== 'baseline') this.setGraphicsMode('baseline');
    this.stage.relight(preset);
    if (mode !== 'baseline') this.setGraphicsMode(mode);
    const fog = this.stage.fog;
    this.fogBase.copy(raw(fog.color));
    for (const f of [this.fog, this.objectFog]) {
      f.near = fog.near;
      f.far = fog.far;
    }
    paintSky(this.dome.geometry, this.stage.sky);
    this.syncLocals();
    for (const guest of this.guests.keys()) guest.relight?.();
    this.draw();
  }

  /** The guests' point lights from the stage's locals (made on first need, then kept). */
  private syncLocals(): void {
    const locals = this.stage.locals;
    if (!locals && !this.guestLocals.length) return;
    while (this.guestLocals.length < LOCAL_BUDGET) {
      const light = new PointLight(0xffffff, 0, 1, 2);
      this.guestLocals.push(light);
      this.guestScene.add(light);
    }
    this.guestLocals.forEach((light, i) => {
      const local = locals?.[i];
      light.userData.base = local?.guest ?? 0;
      light.userData.flicker = local?.flicker ?? 0;
      light.intensity = light.userData.base;
      if (!local) return;
      light.color.set(local.color);
      light.distance = local.range;
      light.position.set(...local.at);
    });
  }

  /** Where the stage puts the camera (its home, before any `aim`). */
  get home(): Stage<H>['camera'] {
    return this.stage.camera;
  }

  /** Look from elsewhere, still and without drift (a dev page's orbit control). */
  aim(
    position: readonly [number, number, number],
    target: readonly [number, number, number],
  ): void {
    this.eye = position;
    this.target.set(...target);
    this.draw();
  }

  /** Renderer counters for the isolated lab; GPU allocation size is not exposed reliably by WebGL. */
  get renderMetrics(): BlockRenderMetrics {
    return this.metrics;
  }

  /** What the world may act on now (or nothing). */
  hold(host: H | undefined): void {
    this.host = host;
  }

  /** Keep the stage and its guest mounted, but spend nothing behind an opaque game screen. */
  setActive(active: boolean): void {
    if (this.active === active || this.disposed) return;
    this.active = active;
    this.sync();
    if (active) this.draw();
  }

  /** Take a guest in: it stands on the anchor block and is drawn with the world. */
  admit(guest: Guest): void {
    const anchor = this.stage.anchor;
    if (!anchor || this.guests.has(guest) || this.disposed) return;
    const place = new Group(),
      eye = this.stage.camera.position,
      front = guest.front ?? [0, 1];
    // The guest's front turns to where the stage says the anchor faces, else to the camera.
    const facing = this.stage.anchorFront ?? [eye[0] - anchor[0], eye[2] - anchor[2]];
    const turn = Math.atan2(facing[0], facing[1]) - Math.atan2(front[0], front[1]);
    place.position.set(...anchor);
    place.rotation.y = turn;
    place.scale.setScalar(1 / guest.unit);
    place.add(guest.root);
    this.guestScene.add(place);
    this.guests.set(guest, place);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const view = this;
    guest.enter?.({
      draw: () => view.draw(),
      approach: (closer, lift = 0) => {
        view.closer = Math.max(0, Math.min(1, closer));
        view.lift = lift;
      },
      picture: (camera, width, height) => view.picture(camera, width, height),
      camera: view.camera,
      physics: view.physics(),
      sync: () => view.physicsWorld?.sync(view.view.performance.now()),
      anchor,
      turn,
      get light() {
        return view.stage.light;
      },
    });
    this.draw();
  }

  /** The world's physics, made on first use: the stage's ground (or a floor under the anchor). */
  private physics(): Promise<WorldPhysics> {
    return (this.physicsLoad ??= WorldPhysics.create(
      this.stage.ground ?? { floor: this.stage.anchor?.[1] ?? 0 },
    ).then((physics) => {
      if (this.disposed) {
        physics.dispose();
        throw new Error('The world was closed.');
      }
      this.physicsWorld = physics;
      return physics;
    }));
  }

  /** Let a guest go; the camera goes home. */
  dismiss(guest: Guest): void {
    const place = this.guests.get(guest);
    if (!place) return;
    this.guests.delete(guest);
    place.remove(guest.root);
    place.removeFromParent();
    this.closer = 0;
    this.lift = 0;
    guest.leave?.();
    this.draw();
  }

  /** One frame at a given time (previews, reduced motion). Living things run without a host. */
  renderAt(seconds: number): void {
    const step = 1 / FPS;
    for (let t = 0; t < seconds; t += step) this.tick(step, false);
    this.draw();
  }

  /** The current picture as an image (a still backdrop for screens that need no live world). */
  snapshot(type = 'image/jpeg', quality = 0.85, options: { guests?: boolean } = {}): string {
    // Without its guests (and the veil for an interface): the world alone, a backdrop for other screens.
    this.withoutGuests = options.guests === false;
    try {
      this.draw(true);
      return this.canvas.toDataURL(type, quality);
    } finally {
      this.withoutGuests = false;
      this.draw();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    try {
      this.close();
    } finally {
      // Whatever failed above, the root leaves the scene (a cached world can be shown again) and the
      // view's own stage is freed.
      this.scene.remove(this.stage.root);
      if (this.stage.objects) this.objectScene.remove(this.stage.objects);
      if (this.ownsStage) this.stage.dispose?.();
    }
  }

  private close(): void {
    for (const guest of [...this.guests.keys()]) this.dismiss(guest);
    this.disposed = true;
    this.running = false;
    this.physicsWorld?.dispose();
    this.physicsWorld = undefined;
    this.view.cancelAnimationFrame(this.frame);
    this.canvas.ownerDocument.removeEventListener('visibilitychange', this.onChange);
    this.motion.removeEventListener('change', this.onChange);
    this.resizeObserver?.disconnect();
    // A cached stage stays for the session; only this view's own objects go.
    for (const entry of this.shadowMaterials) {
      entry.mesh.material = entry.baseline;
      entry.experiment.dispose();
    }
    this.shadowMaterials.length = 0;
    this.scene.remove(this.sunLight, this.sunLight.target, this.fillLight);
    for (const light of this.guestLocals.splice(0)) {
      this.guestScene.remove(light);
      light.dispose();
    }
    this.dome.geometry.dispose();
    (this.dome.material as MeshBasicMaterial).dispose();
    this.veil?.scene.traverse((object) => {
      if (object instanceof Mesh) object.geometry.dispose();
    });
    this.veil?.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.width = this.canvas.height = 0;
    this.canvas.remove();
  }

  private resize(): void {
    const box = this.canvas.parentElement?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return;
    this.renderer.setSize(box.width, box.height, false);
    this.camera.aspect = box.width / box.height;
    // The target shows at the stage's focus: the picture is cut from a frame shifted that way.
    const [fx, fy] = this.stage.camera.focus ?? [0.5, 0.5];
    if (fx !== 0.5 || fy !== 0.5)
      this.camera.setViewOffset(
        box.width,
        box.height,
        (0.5 - fx) * box.width,
        (0.5 - fy) * box.height,
        box.width,
        box.height,
      );
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  private sync(): void {
    const live =
      this.active &&
      !this.disposed &&
      this.canvas.ownerDocument.visibilityState !== 'hidden' &&
      !this.motion.matches;
    if (live && !this.running) {
      this.running = true;
      this.last = this.view.performance.now();
      this.frame = this.view.requestAnimationFrame(this.loop);
    } else if (!live && this.running) {
      this.running = false;
      this.view.cancelAnimationFrame(this.frame);
      if (!this.disposed) this.draw();
    }
  }

  private readonly loop = (now: number) => {
    if (!this.running) return;
    this.frame = this.view.requestAnimationFrame(this.loop);
    // Physics keeps its own time every frame, whatever the drawing budget.
    this.physicsWorld?.sync(now);
    const elapsed = (now - this.last) / 1000;
    if (elapsed < 1 / this.fps - 0.002) return;
    this.last = now;
    const started = this.view.performance.now();
    this.tick(Math.min(elapsed, 0.1), true);
    this.sceneMs += this.view.performance.now() - started;
    // A guest that moves draws every frame itself; no need to draw twice.
    if (now - this.lastDrawn > (1000 / this.fps) * 0.5) this.draw();
  };

  /** A weak machine must not pay for the scenery: lower resolution, then fewer frames, then a still. */
  private budget(spentMs: number): void {
    this.slow = spentMs > 12 ? this.slow + 1 : Math.max(0, this.slow - 1);
    if (this.slow < 20) return;
    this.slow = 0;
    if (this.quality > 0.45) {
      this.quality = Math.max(0.4, this.quality - 0.15);
      this.renderer.setPixelRatio(this.quality);
      this.resize();
      return;
    }
    if (this.fps > MIN_FPS) {
      this.fps = MIN_FPS;
      return;
    }
    // With guests the world must go on (their physics lives here); alone it may become a still.
    if (this.guests.size > 0) return;
    this.running = false;
    this.view.cancelAnimationFrame(this.frame);
  }

  /** Hand the shaders this stage's sun and sky (several views may share the page). */
  private atmosphere(): void {
    const sun = this.stage.sun;
    atmosphere.time.value = this.time;
    atmosphere.wind.value = this.wind;
    atmosphere.flicker.value = this.stage.flicker ?? 0.08;
    atmosphere.exposure.value = this.stage.exposure ?? 1;
    atmosphere.horizon.value.copy(raw(this.stage.sky.horizon));
    if (sun) {
      atmosphere.sunDirection.value.set(...sun.direction).normalize();
      // A lightning flash outshines the sun for a moment.
      atmosphere.sunColor.value.copy(raw(sun.color)).lerp(this.flashColor, this.flashLevel);
      atmosphere.scatter.value = sun.scatter ?? 0.8;
    } else {
      atmosphere.sunColor.value.setRGB(0, 0, 0);
      atmosphere.scatter.value = 0;
    }
  }

  private tick(dt: number, live: boolean): void {
    this.time += dt;
    this.gustLevel = Math.max(0, this.gustLevel - dt * 0.35);
    this.flashLevel = Math.max(0, this.flashLevel - dt * 3.5);
    this.wind =
      (this.stage.calm ?? 0.1) * (0.7 + 0.3 * Math.sin(this.time * 0.7)) +
      this.gustLevel * this.gustSide;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const context: StageContext<H> = {
      time: this.time,
      wind: this.wind,
      rand: this.rand,
      host: live ? this.host : undefined,
      gust(strength, side) {
        self.gustLevel = Math.max(self.gustLevel, Math.min(1, strength));
        self.gustSide = side < 0 ? -1 : 1;
      },
      flash(color, strength) {
        self.flashColor.copy(raw(color));
        self.flashLevel = Math.max(self.flashLevel, Math.min(1, strength));
      },
      blast(at, strength, radius) {
        if (live) self.physicsWorld?.blast(at, strength, radius);
      },
    };
    for (const thing of this.stage.living) thing.update(context, dt);
    atmosphere.time.value = this.time;
    atmosphere.wind.value = this.wind;
    for (const light of this.guestLocals)
      if (light.userData.flicker)
        light.intensity =
          light.userData.base *
          (1 + light.userData.flicker * flickerBeat(this.time, light.position.x, light.position.z));
  }

  private draw(force = false): void {
    if (this.disposed || (!this.active && !force)) return;
    const camera = this.stage.camera,
      t = this.time,
      drift = this.eye ? 0 : (camera.drift ?? 1),
      home = this.eye ?? camera.position;
    // A slow drift: the world is a place, not a picture.
    this.camera.position.set(
      home[0] + Math.sin(t * 0.05) * 2.2 * drift,
      home[1] + Math.sin(t * 0.07) * 0.4 * drift,
      home[2] + Math.cos(t * 0.04) * 1.2 * drift,
    );
    // Moving in on a guest: along the line to the target, the aim raised a little.
    AIM.copy(this.target).setY(this.target.y + this.lift);
    if (this.closer > 0 || this.lift !== 0)
      this.camera.position
        .sub(AIM)
        .multiplyScalar(1 - this.closer)
        .add(AIM);
    this.camera.lookAt(AIM);
    this.dome.position.copy(this.camera.position);
    this.fog.color.copy(this.fogBase).lerp(this.flashColor, this.flashLevel * 0.6);
    (this.dome.material as MeshBasicMaterial).color.setScalar(1 + this.flashLevel * 1.5);
    this.atmosphere();
    this.lastDrawn = this.view.performance.now();
    const renderer = this.renderer,
      started = this.view.performance.now();
    renderer.info.reset();
    renderer.outputColorSpace =
      this.graphicsMode === 'shadow-poc' ? SRGBColorSpace : LinearSRGBColorSpace;
    renderer.toneMapping =
      this.graphicsMode === 'shadow-poc' ? ACESFilmicToneMapping : NoToneMapping;
    renderer.shadowMap.enabled = this.graphicsMode === 'shadow-poc';
    renderer.shadowMap.type = this.graphicsMode === 'shadow-poc' ? PCFSoftShadowMap : PCFShadowMap;
    renderer.localClippingEnabled = false;
    renderer.autoClear = true;
    renderer.render(this.scene, this.camera);
    renderer.autoClear = false;
    if (this.stage.objects) {
      // Standard colour: the materials' linear results are written as sRGB; the tone curve stays the world's.
      renderer.outputColorSpace = SRGBColorSpace;
      this.objectFog.color.copy(this.fog.color).convertSRGBToLinear();
      renderer.render(this.objectScene, this.camera);
    }
    if (this.veil && !this.withoutGuests) renderer.render(this.veil.scene, this.veil.camera);
    if (this.guests.size === 0 || this.withoutGuests) {
      renderer.autoClear = true;
      this.recordMetrics(started);
      return;
    }
    // The guests, over the world and in its depth, each in its own look.
    for (const guest of this.guests.keys()) {
      const look = guest.look ?? {};
      renderer.outputColorSpace = look.srgb ? SRGBColorSpace : LinearSRGBColorSpace;
      renderer.toneMapping = look.toneMapping ?? NoToneMapping;
      renderer.toneMappingExposure = (look.exposure ?? 1) * (this.stage.exposure ?? 1);
      renderer.shadowMap.enabled = look.shadows === true;
      renderer.localClippingEnabled = look.clipping === true;
      for (const [other, place] of this.guests) place.visible = other === guest;
      renderer.render(this.guestScene, this.camera);
    }
    for (const place of this.guests.values()) place.visible = true;
    renderer.autoClear = true;
    this.recordMetrics(started);
  }

  private recordMetrics(started: number): void {
    const renderer = this.renderer,
      now = this.view.performance.now();
    if (!this.fpsWindow) this.fpsWindow = now;
    this.fpsFrames++;
    this.frameMsSum += now - started;
    this.frameSamples++;
    let fps = this.metrics.fps,
      frameMs = this.metrics.frameMs;
    if (now - this.fpsWindow >= 1000) {
      fps = (this.fpsFrames * 1000) / (now - this.fpsWindow);
      frameMs = this.frameSamples ? this.frameMsSum / this.frameSamples : 0;
      this.fpsWindow = now;
      this.fpsFrames = 0;
      this.frameMsSum = 0;
      this.frameSamples = 0;
    }
    this.metrics = {
      mode: this.graphicsMode,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      frameMs,
      fps,
      shadowMap: this.graphicsMode === 'shadow-poc',
    };
    renderer.info.reset();
    // Guests can drive all renders themselves. Charge those draws to the same budget,
    // otherwise the expensive chest animation bypasses adaptation entirely.
    const spent = now - started + this.sceneMs;
    this.sceneMs = 0;
    if (this.active) this.budget(spent);
  }

  /** The guests alone, on a clear background, from another camera: a picture for elsewhere. */
  private picture(camera: Camera, width: number, height: number): string {
    const renderer = this.renderer,
      size = renderer.getSize(new Vector2()),
      ratio = renderer.getPixelRatio();
    const look = [...this.guests.keys()][0]?.look ?? {},
      clear = renderer.getClearColor(new Color()),
      alpha = renderer.getClearAlpha();
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = look.srgb ? SRGBColorSpace : LinearSRGBColorSpace;
    renderer.toneMapping = look.toneMapping ?? NoToneMapping;
    renderer.toneMappingExposure = look.exposure ?? 1;
    renderer.shadowMap.enabled = look.shadows === true;
    renderer.localClippingEnabled = look.clipping === true;
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.render(this.guestScene, camera);
    const image = this.canvas.toDataURL('image/png');
    renderer.setClearColor(clear, alpha);
    renderer.setPixelRatio(ratio);
    renderer.setSize(size.x, size.y, false);
    this.resize();
    return image;
  }
}
