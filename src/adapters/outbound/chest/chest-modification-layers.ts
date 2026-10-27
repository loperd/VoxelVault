import {
  Box3,
  BoxGeometry,
  Color,
  DataTexture,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  NormalBlending,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  RGBAFormat,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  type Object3D,
} from 'three';
import type { ResolvedModification } from '../../../domain/chest-appearance.ts';
import type { ChestModificationProfile, GrowthStyle } from '../../../domain/chest-modifications.ts';
import { meshesOf } from './chest-appearance.ts';
import {
  cobwebSprite,
  glowPattern,
  growthPattern,
  PATTERN_SIZE,
  random,
  snowSprite,
  SPRITE_SIZE,
  vineSprite,
  wearPattern,
} from './chest-surface-patterns.ts';

/**
 * Projects a 128px mask by the dominant axis of the local normal instead of the mesh UVs: the
 * same pattern density on every model, including atlas-mapped ones.
 * 0.5 world units per pattern repeat at scale 1 ≈ 64 pattern pixels per model unit.
 */
export const PROJECTED_VERTEX = `varying vec3 vLocal; varying vec3 vLocalNormal;
  void main() { vLocal = position; vLocalNormal = normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
export const PROJECTED_UV = `uniform float patternScale; varying vec3 vLocal; varying vec3 vLocalNormal;
  vec2 projectedUv() { vec3 n = abs(normalize(vLocalNormal));
    vec2 uv = n.x > n.y && n.x > n.z ? vLocal.zy : (n.y > n.z ? vLocal.xz : vLocal.xy);
    return uv * patternScale * 0.5; }`;

export function patternTexture(pixels: Uint8Array, size = PATTERN_SIZE): DataTexture {
  const texture = new DataTexture(pixels, size, size, RGBAFormat);
  texture.magFilter = texture.minFilter = NearestFilter;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** Shares the base geometry, sits just above the surface and is ignored by palette/physics lookups. */
export function overlay(surface: Mesh, material: ShaderMaterial, order: number): Mesh {
  const mesh = new Mesh(surface.geometry, material);
  mesh.userData.chestOverlay = true;
  mesh.renderOrder = order;
  surface.add(mesh);
  return mesh;
}

const ANCHORS = { top: 0, bottom: 1, edges: 2, all: 3 } as const;
/**
 * Overlays are unlit ShaderMaterials: shade them with a fixed key light in model space so they sit on
 * the lit chest instead of floating as flat paint, then convert to the output colour space.
 */
const FINISH_GLSL = `vec3 lit(vec3 color) { vec3 n = normalize(vLocalNormal);
    return color * (.5 + .55 * clamp(dot(n, normalize(vec3(-.35, 1.0, .55))), 0.0, 1.0)); }`;
// Preprocessor directives must start a line, so the snippet carries its own line breaks.
const OUTPUT = '\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n';
/** 0..1 closeness to where the effect starts, from this mesh's own bounds. */
const ANCHOR_GLSL = `uniform vec3 boundsMin; uniform vec3 boundsMax; uniform int anchor;
  float anchorBias() {
    vec3 p = (vLocal - boundsMin) / max(boundsMax - boundsMin, vec3(1e-4));
    if (anchor == 0) return p.y;
    if (anchor == 1) return 1.0 - p.y;
    if (anchor == 2) { vec3 n = abs(normalize(vLocalNormal));
      vec2 f = n.x > n.y && n.x > n.z ? p.zy : (n.y > n.z ? p.xz : p.xy);
      return 1.0 - clamp(min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) * 3.0, 0.0, 1.0); }
    return 1.0;
  }
  // Full intensity covers roughly half a face: an overgrown chest, still recognisably a chest.
  float reachAt(float intensity) { return (.12 + intensity * .5) * (anchor == 3 ? 1.0 : mix(.3, 1.35, anchorBias())); }`;
const shaders = {
  wear: `${ANCHOR_GLSL} uniform sampler2D mask; uniform float intensity; uniform float opacity; uniform vec3 tint; uniform vec3 tintEnd;
    void main() { vec4 m = texture2D(mask, projectedUv());
      if (m.a < .5 || m.r > reachAt(intensity)) discard;
      // Later spots carry the ageing colour, so stronger wear reads as an older surface.
      vec3 base = mix(tint, tintEnd, smoothstep(.2, .9, m.r));
      gl_FragColor = vec4(lit(mix(base, vec3(.82, .8, .74), m.g * .55)), opacity * (1.0 + m.g * .15)); ${OUTPUT} }`,
  // Carved symbol: a dark groove with dim light at the bottom, no additive neon.
  glow: `uniform sampler2D mask; uniform float intensity; uniform float strength; uniform float brightness; uniform vec3 tint;
    void main() { vec4 m = texture2D(mask, projectedUv());
      if (m.a < .5 || m.r > intensity) discard;
      // Engraved glyph: lit from inside, lighter than dark stone, never additive.
      gl_FragColor = vec4(mix(vec3(.02, .03, .03), tint, brightness * strength), .9); ${OUTPUT} }`,
  growth: `${ANCHOR_GLSL} uniform sampler2D mask; uniform float intensity; uniform float spread; uniform float opacity; uniform vec3 tint;
    uniform float glow; uniform vec3 highlight; uniform float hasHighlight;
    void main() { vec4 m = texture2D(mask, projectedUv());
      float facing = anchor != 0 || normalize(vLocalNormal).y > .5 ? 1.0 : spread;
      float reach = reachAt(intensity) * facing;
      float edge = reach - m.r;
      if (m.a < .5 || edge < 0.0) discard;
      if (m.g > .5 && hasHighlight > .5) { gl_FragColor = vec4(highlight * (1.0 + glow * 1.5), 1.0); ${OUTPUT} return; }
      // b is the leaf shade: dark roots to sunlit tips, warmer as it brightens (moss reads as plant, not paint).
      vec3 leaf = mix(tint * .5, tint * 1.12 + vec3(.02, .025, 0.0), m.b);
      // Thin fringe at the growth boundary keeps patches soft without blurring the pixel look.
      gl_FragColor = vec4(lit(leaf) * (1.0 + glow * .3), opacity * (edge < .06 ? .55 : 1.0)); ${OUTPUT} }`,
};

interface Animated {
  material: ShaderMaterial;
  intensity: number;
  pulse: number;
  phase: number;
}

/** Static instance modifications (wear, glow, growth) drawn on the parts their catalogue entry names. */
export class ChestModificationLayers {
  private readonly disposables: { dispose(): void }[] = [];
  private readonly added: Object3D[] = [];
  private readonly animated: Animated[] = [];
  private time = 0;

  constructor(
    root: Object3D,
    profile: ChestModificationProfile,
    modifications: readonly ResolvedModification[],
    accent: number,
  ) {
    const parts = new Map(profile.parts.map((part) => [part.id, part.nodes]));
    modifications.forEach(({ definition, intensity, seed }, index) => {
      const surfaces = meshesOf(
        root,
        definition.parts.flatMap((part) => parts.get(part) ?? []),
      );
      if (!surfaces.length) return;
      if (definition.kind === 'fracture') return; // drawn and animated by ChestFractureEffects
      if (
        definition.kind === 'growth' &&
        this.geometryGrowth(surfaces, definition.style, intensity, seed)
      )
        return;
      const texture = patternTexture(
        definition.kind === 'wear'
          ? wearPattern(definition.style, seed)
          : definition.kind === 'glow'
            ? glowPattern(definition.style, seed)
            : growthPattern(definition.style, seed),
      );
      const tint = new Color(
        definition.kind === 'glow' ? (definition.style.color ?? accent) : definition.style.color,
      );
      const growth = definition.kind === 'growth' ? definition.style : undefined;
      this.disposables.push(texture);
      // One material per surface: growth anchors need that mesh's own bounds.
      for (const surface of surfaces) {
        surface.geometry.computeBoundingBox();
        const bounds =
          surface.geometry.boundingBox ?? new Box3(new Vector3(), new Vector3(1, 1, 1));
        const material = new ShaderMaterial({
          uniforms: {
            mask: { value: texture },
            intensity: { value: intensity },
            tint: { value: tint },
            tintEnd: {
              value: new Color(
                definition.kind === 'wear'
                  ? (definition.style.colorEnd ?? definition.style.color)
                  : 0,
              ),
            },
            patternScale: { value: definition.style.scale },
            strength: { value: 1 },
            brightness: { value: definition.kind === 'glow' ? definition.style.brightness : 1 },
            spread: { value: growth?.spread ?? 1 },
            opacity: {
              value: growth?.opacity ?? (definition.kind === 'wear' ? definition.style.opacity : 1),
            },
            anchor: {
              value:
                ANCHORS[
                  growth?.anchor ?? (definition.kind === 'wear' ? definition.style.anchor : 'all')
                ],
            },
            glow: { value: growth?.glow ?? 0 },
            highlight: { value: new Color(growth?.highlight ?? 0) },
            hasHighlight: { value: growth?.highlight ? 1 : 0 },
            boundsMin: { value: bounds.min.clone() },
            boundsMax: { value: bounds.max.clone() },
          },
          vertexShader: PROJECTED_VERTEX,
          fragmentShader: PROJECTED_UV + FINISH_GLSL + shaders[definition.kind],
          transparent: true,
          depthWrite: false,
          blending: NormalBlending,
          // A constant depth nudge, not a slope-scaled one: a slope factor grows huge on faces seen at
          // a grazing angle and lets the overlays of neighbouring faces bleed through (smeared moss).
          polygonOffset: true,
          polygonOffsetFactor: 0,
          polygonOffsetUnits: -4 - index * 2,
        });
        this.disposables.push(material);
        this.added.push(overlay(surface, material, 3 + index));
        if (definition.kind === 'glow' && definition.style.pulse > 0) {
          this.animated.push({
            material,
            intensity,
            pulse: definition.style.pulse,
            phase: (seed % 1000) / 1000,
          });
        }
      }
    });
  }

  /** Glow pulse; layers are fully drawn without calling it (previews). */
  update(delta: number): void {
    this.time += delta;
    for (const item of this.animated) {
      item.material.uniforms.strength!.value =
        0.75 + 0.25 * Math.sin((this.time * item.pulse + item.phase) * Math.PI * 2);
    }
  }

  dispose(): void {
    for (const object of this.added) object.removeFromParent();
    for (const item of this.disposables) item.dispose();
    this.added.length = this.disposables.length = this.animated.length = 0;
  }

  /** Growth made of small geometry; returns false for surface growths. Front of the model is +Z. */
  private geometryGrowth(
    surfaces: readonly Mesh[],
    style: GrowthStyle,
    intensity: number,
    seed: number,
  ): boolean {
    const builders = {
      crystals: this.crystals,
      vines: this.vines,
      cobweb: this.cobwebs,
      snow: this.snow,
    } as const;
    const build = builders[style.type as keyof typeof builders];
    if (!build) return false;
    const next = random(seed);
    const count = Math.max(1, Math.round(style.count * intensity));
    for (let index = 0; index < count; index++) {
      const surface = surfaces[Math.floor(next() * surfaces.length)]!;
      surface.geometry.computeBoundingBox();
      const box = surface.geometry.boundingBox ?? new Box3(),
        size = box.getSize(new Vector3());
      // One model pixel (1/16 of the part width) as the voxel unit, matching the chest texture grid.
      const unit = (Math.max(size.x, size.z) / 16) * style.scale;
      const before = this.added.length;
      build.call(this, {
        surface,
        box,
        size,
        unit,
        next,
        style,
        intensity,
        first: index === 0,
        faces: facesOf(surface, box),
      });
      // What it is decides how it behaves when the chest is jolted (vines fall off, cobweb sticks).
      for (const mesh of this.added.slice(before)) mesh.userData.growth = style.type;
    }
    return true;
  }

  /** A sprite plane flat on a vertical face, hanging from its top edge at `along` (0..1) of its width. */
  private onFace(
    surface: Mesh,
    face: Face,
    material: MeshStandardMaterial,
    width: number,
    height: number,
    along: number,
    gap: number,
  ) {
    const geometry = new PlaneGeometry(1, 1);
    this.disposables.push(geometry);
    const plane = new Mesh(geometry, material);
    plane.scale.set(width, -height, 1); // sprite row 0 at the upper edge (DataTexture rows run bottom-up)
    plane.position.copy(face.point(along, height / 2)).addScaledVector(face.normal, gap);
    plane.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), face.normal); // plane +Z along the outward face normal
    this.attach(surface, plane);
    return plane;
  }

  private attach(surface: Mesh, mesh: Mesh) {
    // Loose growth (snow, crystals, cobweb, vines) is not part of the chest: the energy beam can tear it off.
    mesh.userData.chestOverlay = true;
    mesh.userData.loose = true;
    mesh.castShadow = true;
    surface.add(mesh);
    this.added.push(mesh);
  }

  private spriteMaterial(pixels: Uint8Array, color = '#ffffff') {
    const map = patternTexture(pixels, SPRITE_SIZE);
    map.colorSpace = SRGBColorSpace; // sprite colours are authored in sRGB, like the chest texture
    const material = new MeshStandardMaterial({
      map,
      color,
      alphaTest: 0.5,
      side: DoubleSide,
      roughness: 0.9,
    });
    this.disposables.push(map, material);
    return material;
  }

  /** Voxel druse at the rear corners of the top face: a few axis-aligned blocks, matte. */
  private crystals({ surface, box, size, unit, next, style }: GrowthContext) {
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardMaterial({
      color: style.color,
      emissive: style.color,
      emissiveIntensity: 0.08 + style.glow * 0.4,
      roughness: 0.55,
    });
    this.disposables.push(geometry, material);
    const edge = () => (next() < 0.5 ? 0.08 + next() * 0.18 : 0.74 + next() * 0.18);
    const cx = box.min.x + size.x * edge(),
      cz = box.min.z + size.z * (0.08 + next() * 0.3);
    for (let block = 0, blocks = 2 + Math.floor(next() * 3); block < blocks; block++) {
      const crystal = new Mesh(geometry, material);
      const height = unit * (1 + Math.floor(next() * 3));
      crystal.scale.set(unit, height, unit);
      crystal.position.set(
        cx + Math.round(next() * 2 - 1) * unit,
        box.max.y + height / 2,
        cz + Math.round(next() * 2 - 1) * unit,
      );
      this.attach(surface, crystal);
    }
  }

  /** Strands hanging from the top edge of the front or a side face; on the lid they swing with it. */
  private vines({ surface, unit, next, style, faces }: GrowthContext) {
    // Front and both sides; the back is never seen in the game camera.
    const face = [faces.front, faces.left, faces.right][Math.floor(next() * 3)]!;
    const span = SPRITE_SIZE * unit * 0.5;
    this.onFace(
      surface,
      face,
      this.spriteMaterial(vineSprite(style.color, Math.floor(next() * 0xffffffff))),
      span,
      span,
      0.15 + next() * 0.7,
      unit * 0.15,
    );
  }

  /** Corner webs on the front or rear face, mirrored for the right-hand corners. */
  private cobwebs({ surface, unit, next, style, faces }: GrowthContext) {
    const face = [faces.front, faces.left, faces.right][Math.floor(next() * 3)]!;
    const span = unit * 10,
      right = next() < 0.5;
    // Corner of the sprite (row 0, column 0) goes into the face's top corner; mirrored for the right one.
    const web = this.onFace(
      surface,
      face,
      this.spriteMaterial(cobwebSprite(style.color, Math.floor(next() * 0xffffffff))),
      span,
      span,
      right ? 1 - span / 2 / face.width : span / 2 / face.width,
      unit * 0.2,
    );
    if (right) web.scale.x = -web.scale.x;
    web.castShadow = false;
    const material = web.material as MeshStandardMaterial;
    material.transparent = true;
    material.opacity = 0.75;
    material.depthWrite = false;
  }

  /**
   * Uneven snow layer: 2×2-texel columns over the top face, one or two texels high, with bald
   * patches; more intensity, fewer gaps and more double drifts. Built once per part.
   */
  private snow({ surface, box, size, unit, next, style, intensity, first }: GrowthContext) {
    if (!first) return;
    const geometry = new BoxGeometry(1, 1, 1);
    const material = this.spriteMaterial(snowSprite(style.color, Math.floor(next() * 0xffffffff)));
    material.map!.repeat.set(0.25, 0.25); // one 4px sprite block per texel
    this.disposables.push(geometry);
    const cell = unit * 2,
      columns = Math.max(1, Math.round(size.x / cell)),
      rows = Math.max(1, Math.round(size.z / cell));
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const edge = Math.min(column, row, columns - 1 - column, rows - 1 - row);
        // Wind keeps edges barer than the middle.
        if (next() > intensity * (edge === 0 ? 0.55 : 0.85)) continue;
        const height = unit * (next() < intensity * 0.45 ? 2 : 1);
        const block = new Mesh(geometry, material);
        block.scale.set(size.x / columns, height, size.z / rows);
        block.position.set(
          box.min.x + ((column + 0.5) * size.x) / columns,
          box.max.y + height / 2,
          box.min.z + ((row + 0.5) * size.z) / rows,
        );
        this.attach(surface, block);
      }
    }
  }
}

interface GrowthContext {
  readonly surface: Mesh;
  readonly box: Box3;
  readonly size: Vector3;
  readonly unit: number;
  readonly next: () => number;
  readonly style: GrowthStyle;
  readonly intensity: number;
  readonly first: boolean;
  readonly faces: Record<'front' | 'left' | 'right', Face>;
}

/** A vertical box face in the surface's local space: outward normal, horizontal axis and width. */
interface Face {
  readonly normal: Vector3;
  readonly width: number;
  point(along: number, below: number): Vector3;
}

/**
 * Model nodes are often rotated against each other (Blockbench exports), so "front" is found from
 * the world: the chest front faces the camera at world -Z. The world direction is taken into the
 * surface's local space and snapped to its nearest box face.
 */
function facesOf(surface: Mesh, box: Box3): Record<'front' | 'left' | 'right', Face> {
  surface.updateWorldMatrix(true, false);
  const inverse = surface.getWorldQuaternion(new Quaternion()).invert();
  const local = (x: number, z: number) => {
    const v = new Vector3(x, 0, z).applyQuaternion(inverse);
    const axis = Math.abs(v.x) >= Math.abs(v.z) ? 0 : 2;
    return { axis, sign: Math.sign(axis === 0 ? v.x : v.z) || 1 };
  };
  const face = ({ axis, sign }: { axis: number; sign: number }): Face => {
    const normal = new Vector3().setComponent(axis, sign);
    const across = axis === 0 ? 2 : 0,
      min = box.min.getComponent(across),
      max = box.max.getComponent(across);
    const plane = sign > 0 ? box.max.getComponent(axis) : box.min.getComponent(axis);
    return {
      normal,
      width: max - min,
      point(along, below) {
        return new Vector3()
          .setComponent(axis, plane)
          .setComponent(across, min + (max - min) * along)
          .setY(box.max.y - below);
      },
    };
  };
  return { front: face(local(0, -1)), left: face(local(-1, 0)), right: face(local(1, 0)) };
}
