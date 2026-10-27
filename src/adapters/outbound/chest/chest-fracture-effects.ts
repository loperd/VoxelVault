import {
  createChestAppearance,
  modificationSeed,
  type ChestAppearance,
} from '../../../domain/chest-appearance.ts';
import type {
  ChestModificationProfile,
  ModificationDefinition,
} from '../../../domain/chest-modifications.ts';
import {
  AdditiveBlending,
  Color,
  Group,
  Mesh,
  PointLight,
  ShaderMaterial,
  type DataTexture,
  type Object3D,
} from 'three';
import { meshesOf } from './chest-appearance.ts';
import {
  overlay,
  patternTexture,
  PROJECTED_UV,
  PROJECTED_VERTEX,
} from './chest-modification-layers.ts';
import { fracturePattern, PATTERN_SIZE } from './chest-surface-patterns.ts';

interface FractureSet {
  readonly baseline: number;
  readonly texture: DataTexture;
  readonly glow: ShaderMaterial;
  readonly scar: ShaderMaterial;
  readonly overlays: Mesh[];
  readonly scars: Mesh[];
}

/**
 * Animated cracks of the fracture entries in the model catalogue. Each entry has its own style and
 * parts; the stored instance intensity is the baseline scar. Emission fades; surface scars survive
 * until the chest session resets. A model without fracture entries never cracks.
 */
export class ChestFractureEffects {
  private readonly sets: FractureSet[] = [];
  private readonly light = new PointLight(0x65ffd0, 0, 5, 2);
  private readonly attachment = new Group();
  private age = Infinity;
  private reduced = false;

  constructor(
    chest: Object3D,
    color: number,
    appearance: ChestAppearance = createChestAppearance(),
    profile?: ChestModificationProfile,
  ) {
    this.light.color.setHex(color);
    const applied = new Map(appearance.modifications.map((item) => [item.id, item]));
    const parts = new Map(profile?.parts.map((part) => [part.id, part.nodes]) ?? []);
    const fractures = (profile?.catalog ?? []).filter(
      (entry): entry is Extract<ModificationDefinition, { kind: 'fracture' }> =>
        entry.kind === 'fracture',
    );
    for (const definition of fractures) {
      const surfaces = meshesOf(
        chest,
        definition.parts.flatMap((part) => parts.get(part) ?? []),
      );
      if (!surfaces.length) continue;
      const own = applied.get(definition.id);
      // Seeded per entry, so a scar keeps its shape between the preview, the scene and reloads.
      const texture = patternTexture(
        fracturePattern(
          definition.style,
          own?.seed ?? modificationSeed(appearance.seed, definition.id),
        ),
      );
      const common = {
        fractureMap: { value: texture },
        patternScale: { value: definition.style.scale },
      };
      const glow = new ShaderMaterial({
        uniforms: {
          ...common,
          reveal: { value: 0 },
          strength: { value: 0 },
          tint: { value: new Color(color) },
        },
        vertexShader: PROJECTED_VERTEX,
        fragmentShader: `${PROJECTED_UV} uniform sampler2D fractureMap; uniform float reveal; uniform float strength; uniform vec3 tint;
          void main() { vec4 crack = texture2D(fractureMap, projectedUv());
            float alpha = crack.a * smoothstep(crack.r - 0.06, crack.r + 0.06, reveal) * strength;
            if (alpha < 0.01) discard;
            gl_FragColor = vec4(tint, alpha); }`,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        polygonOffset: true,
        polygonOffsetFactor: 0,
        polygonOffsetUnits: -3,
        toneMapped: false,
      });
      const scarColor = new Color(definition.style.scarColor);
      const scar = new ShaderMaterial({
        // reveal = damage: low levels show the first short cracks, high levels the whole network.
        uniforms: {
          ...common,
          reveal: { value: own?.intensity ?? 0 },
          scarOpacity: { value: own ? 1 : 0 },
          core: { value: scarColor },
          rim: { value: new Color(0x71878a) },
        },
        vertexShader: PROJECTED_VERTEX,
        fragmentShader: `${PROJECTED_UV} uniform sampler2D fractureMap; uniform float reveal; uniform float scarOpacity;
          uniform vec3 core; uniform vec3 rim;
          float maskAt(vec2 uv) { vec4 c = texture2D(fractureMap, uv); return c.a * smoothstep(c.r - 0.06, c.r + 0.06, reveal); }
          void main() { vec2 uv = projectedUv(); float centre = maskAt(uv);
            vec2 stepUv = vec2(1.0 / ${PATTERN_SIZE}.0, 0.0);
            // One-sided chipped lip (the texel above-left of the fissure), like a chiselled crack.
            float edge = max(maskAt(uv - stepUv.yx), maskAt(uv + stepUv)) * (1.0 - centre);
            float alpha = max(centre * 0.95, edge * 0.6) * scarOpacity;
            if (alpha < 0.01) discard;
            gl_FragColor = vec4(mix(rim, core, centre), alpha); }`,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: 0,
        polygonOffsetUnits: -2,
      });
      const set: FractureSet = {
        baseline: own?.intensity ?? 0,
        texture,
        glow,
        scar,
        overlays: [],
        scars: [],
      };
      for (const surface of surfaces) {
        const scarMesh = overlay(surface, scar, 1),
          glowMesh = overlay(surface, glow, 2);
        scarMesh.visible = set.baseline > 0;
        glowMesh.visible = false;
        set.scars.push(scarMesh);
        set.overlays.push(glowMesh);
      }
      this.sets.push(set);
    }
    this.attachment.add(this.light);
    chest.add(this.attachment);
    this.light.position.set(0, 0.6, -1.3);
  }

  /** Whether this model has anything to crack; scenes may skip crack light and sound otherwise. */
  get available(): boolean {
    return this.sets.length > 0;
  }

  start(reduced: boolean): void {
    this.reset();
    this.reduced = reduced;
  }

  charge(progress: number): void {
    const p = Math.max(0, Math.min(progress, 1));
    for (const set of this.sets) {
      for (const mesh of set.overlays) mesh.visible = !this.reduced && p > 0;
      set.glow.uniforms.reveal!.value = p * 0.9;
      set.glow.uniforms.strength!.value = this.reduced
        ? 0
        : p * (0.55 + Math.sin(p * Math.PI * 6) ** 2 * 0.5);
    }
    this.light.intensity = this.reduced || !this.available ? 0 : 3 + p * 12;
  }

  impact(): void {
    if (!this.available) return;
    this.age = 0;
    for (const set of this.sets) {
      set.scar.uniforms.scarOpacity!.value = 1;
      set.scar.uniforms.reveal!.value = Math.max(set.baseline, 0.9);
      for (const mesh of set.scars) mesh.visible = true;
      for (const mesh of set.overlays) mesh.visible = !this.reduced;
    }
  }

  update(delta: number, falling: boolean): void {
    if (Number.isFinite(this.age)) this.age += delta;
    const pulse = Number.isFinite(this.age) ? Math.exp(-this.age * 3.5) : 0;
    this.light.intensity = this.reduced || !this.available ? 0 : (falling ? 6 : 0) + pulse * 18;
    for (const set of this.sets) {
      set.glow.uniforms.reveal!.value = Math.min(this.age / 0.22, 1);
      set.glow.uniforms.strength!.value = this.reduced ? 0 : Math.max(0, 1 - this.age / 1.2) * 0.95;
      if (this.age >= 1.2) for (const mesh of set.overlays) mesh.visible = false;
    }
  }

  reset(): void {
    this.age = Infinity;
    this.light.intensity = 0;
    for (const set of this.sets) {
      set.scar.uniforms.scarOpacity!.value = set.baseline > 0 ? 1 : 0;
      set.scar.uniforms.reveal!.value = set.baseline;
      for (const mesh of set.scars) mesh.visible = set.baseline > 0;
      for (const mesh of set.overlays) mesh.visible = false;
      set.glow.uniforms.strength!.value = 0;
    }
  }

  dispose(): void {
    this.reset();
    this.attachment.removeFromParent();
    for (const set of this.sets) {
      for (const mesh of [...set.scars, ...set.overlays]) mesh.removeFromParent();
      set.scar.dispose();
      set.glow.dispose();
      set.texture.dispose();
    }
    this.sets.length = 0;
    this.light.dispose();
  }
}
