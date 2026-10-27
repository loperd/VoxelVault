import type { ColliderDesc, RigidBody, World } from '@dimforge/rapier3d-compat';
import { physicsEngine } from '../../../../packages/blockworld/src/physics.ts';
import {
  AdditiveBlending,
  Box3,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  PlaneGeometry,
  PointLight,
  Quaternion,
  RepeatWrapping,
  RGBAFormat,
  RingGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import type { BreakMoment, BreakPattern, ChestBreakage } from '../../../domain/chest-breakage.ts';
import { resolveModifications, type ChestAppearance } from '../../../domain/chest-appearance.ts';
import {
  defaultDebris,
  type ChestModificationProfile,
  type DebrisStyle,
} from '../../../domain/chest-modifications.ts';
import { meshesOf } from './chest-appearance.ts';
import { buildFragment, fractureCells } from './chest-fracture-geometry.ts';
import { fracturePattern, PATTERN_SIZE, random, wearPattern } from './chest-surface-patterns.ts';
import type { ResolvedModification } from '../../../domain/chest-appearance.ts';

/**
 * Opening timeline (0..1 of its duration): from CHARGE_AT the energy builds up (glow, swelling,
 * trembling, first chips); at BURST_AT the chest gives way.
 */
export const CHARGE_AT = 0.06,
  BURST_AT = 0.22;
/** When the beam of an intact opening reaches full power (the light burst of ChestOpeningEffects). */
export const BEAM_AT = 0.42;

/** Chunks per pattern: base + severity × extra. `fall` keeps the part whole. */
const CHUNKS: Record<BreakPattern, [number, number]> = {
  shatter: [5, 4],
  split: [2, 1],
  crumble: [4, 3],
  fall: [1, 0],
};
/** Stone and planks snap close to their axes; shatter tilts a little more. */
const JITTER: Record<BreakPattern, number> = { shatter: 0.3, split: 0.15, crumble: 0.2, fall: 0 };
const STONE_DENSITY = 2.4;
const STEP = 1 / 120;

/** What the breakage needs to be heard; the scene passes the game's audio voice. */
export interface BreakageSound {
  strain(charge: number): void;
  burst(strength: number): void;
  breakOnImpact(strength: number): void;
  crumble(level?: number): void;
  thud(mass: number, speed: number): void;
}
const SILENT: BreakageSound = {
  strain() {},
  burst() {},
  breakOnImpact() {},
  crumble() {},
  thud() {},
};

/** Light debris that flutters or fades instead of tumbling as a rigid body. */
interface Particle {
  readonly mesh: Mesh;
  readonly velocity: Vector3;
  readonly spin: Vector3;
  readonly shape: DebrisStyle['shape'];
  readonly size: number;
  age: number;
  readonly life: number;
}
/** A rigid piece: a solid fracture chunk, a whole fallen part or a heavy chip. */
interface Body {
  readonly object: Object3D;
  readonly offset: Matrix4;
  readonly body: RigidBody;
  delay: number;
  readonly launch: () => void;
  readonly mass: number;
  speed: number;
}
interface Swing {
  readonly object: Object3D;
  readonly pivot: Vector3;
  readonly axis: Vector3;
  readonly basePosition: Vector3;
  readonly baseRotation: Quaternion;
  angle: number;
  velocity: number;
  readonly stiffness: number;
  readonly damping: number;
}
interface PartSource {
  readonly meshes: Mesh[];
  readonly severity: number;
  readonly detached: boolean;
  readonly pattern: BreakPattern;
  readonly debris: { style: DebrisStyle; weight: number }[];
  readonly breakMaterial: MeshStandardMaterial;
  /** Damage already on the part (rust, cracks, wear): where it will give way. */
  readonly damage: readonly ResolvedModification[];
}

const LIGHT: Record<
  'leaf' | 'spark' | 'puff',
  { scale: number; gravity: number; drag: number; life: number }
> = {
  leaf: { scale: 1.4, gravity: 2.5, drag: 2.2, life: 2.8 },
  spark: { scale: 0.55, gravity: 1.5, drag: 1.5, life: 0.9 },
  puff: { scale: 2.6, gravity: -0.5, drag: 3, life: 1.3 },
};
const RIGID_SCALE: Record<'chip' | 'shard' | 'flake', [number, number, number]> = {
  chip: [1, 1, 1],
  shard: [0.55, 1.8, 0.55],
  flake: [1.1, 0.3, 1.1],
};

/**
 * Draws the server-decided breakage with real rigid-body physics (Rapier). Two stories:
 *   impact  — mechanical: the hit breaks the chest, heavy chunks slump and settle where it landed;
 *   opening — energy overload: the chest swells, trembles and glows, then bursts with a flash and a
 *             floor shockwave that throws the chunks outwards.
 * Fragments are solid convex chunks cut from the real mesh (chest texture outside, broken stone
 * inside), computed from the seed: no two breaks alike. They collide with the floor, each other and
 * whatever is still standing, then come to rest on a face. Light debris follows the part's
 * modifications: rust flakes, moss leaves, ice, rune sparks.
 *
 * Requires physicsReady() to have completed (the chest scene's world does so).
 */
export class ChestBreakageEffects {
  private readonly engine = physicsEngine();
  private readonly sources: PartSource[] = [];
  /** Parts outside the breakage: they ride on the carrier and fall when it is destroyed. */
  private readonly riders: Mesh[][] = [];
  private readonly carrierDetached: boolean;
  /** All parts: the chest's own extent for cores, flashes and the dust, never its growth. */
  private readonly partMeshes: Mesh[];
  /** Parts that hang from their top edge and swing (latch); loose planes (vines, cobweb) swing too. */
  private readonly swingMeshes: Mesh[];
  private swings?: Swing[];
  /** Kinematic bodies following every part still standing. */
  private readonly partBodies = new Map<Mesh, RigidBody>();
  /** The carrier (body): the beam rises from its top, obstacles are its walls. */
  private readonly carrierMeshes: Mesh[];
  /** Loose pieces torn off by the beam, with where they came from, to put them back on reset. */
  private readonly torn: { object: Object3D; parent: Object3D; matrix: Matrix4 }[] = [];
  private beamed = false;
  private column?: Mesh;
  private columnAge = Infinity;
  private readonly particles: Particle[] = [];
  private readonly bodies: Body[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly shared = new Map<string, BufferGeometry | MeshStandardMaterial>();
  private readonly owned: Material[] = [];
  private readonly world: Object3D;
  private readonly chest: Object3D;
  private readonly floorY: number;
  private readonly seed: number;
  private next: () => number;
  private readonly moment: BreakMoment;
  private readonly accent: Color;
  private readonly flash = new PointLight(0xffffff, 0, 8, 2);
  private physics?: World;
  private accumulator = 0;
  private ring?: Mesh;
  private ringAge = Infinity;
  private flashAge = Infinity;
  private charged = false;
  private burst = false;
  private reduced = false;
  private readonly sound: BreakageSound;

  constructor(
    world: Object3D,
    chest: Object3D,
    profile: ChestModificationProfile,
    appearance: ChestAppearance,
    breakage: ChestBreakage,
    accent: string,
    floorY: number,
    sound: BreakageSound = SILENT,
  ) {
    this.sound = sound;
    this.world = world;
    this.chest = chest;
    this.floorY = floorY;
    this.seed = breakage.seed;
    this.next = random(breakage.seed);
    this.moment = breakage.moment;
    this.accent = new Color(accent);
    this.flash.color.copy(this.accent);
    const parts = new Map(profile.parts.map((part) => [part.id, part.nodes]));
    this.carrierMeshes = profile.parts[0] ? meshesOf(chest, profile.parts[0].nodes) : [];
    this.partMeshes = profile.parts.flatMap((part) => meshesOf(chest, part.nodes));
    this.swingMeshes = profile.parts
      .filter((part) => part.swing)
      .flatMap((part) => meshesOf(chest, part.nodes));
    const resolved = resolveModifications(appearance, profile);
    for (const item of breakage.parts) {
      const meshes = meshesOf(chest, parts.get(item.part) ?? []);
      if (!meshes.length || (item.severity === 0 && !item.detached)) continue;
      const stone = averageColor(meshes[0]!);
      const debris = [
        {
          style: { shape: 'chip', color: '#' + stone.getHexString(), share: 1 } as DebrisStyle,
          weight: 1,
        },
        ...resolved
          .filter((mod) => mod.definition.parts.includes(item.part))
          .map((mod) => {
            const style = defaultDebris(mod.definition, accent);
            return { style, weight: style.share * mod.intensity };
          }),
      ];
      const damage = resolved.filter(
        (mod) =>
          mod.definition.parts.includes(item.part) &&
          (mod.definition.kind === 'wear' || mod.definition.kind === 'fracture'),
      );
      this.sources.push({
        meshes,
        severity: item.severity,
        detached: item.detached,
        pattern: item.pattern,
        debris,
        breakMaterial: this.breakMaterial(stone, item.part),
        damage,
      });
    }
    const carrier = profile.parts[0]?.id;
    this.carrierDetached = breakage.parts.some((item) => item.part === carrier && item.detached);
    if (this.carrierDetached) {
      for (const part of profile.parts.slice(1)) {
        if (breakage.parts.some((item) => item.part === part.id && item.detached)) continue;
        const meshes = meshesOf(chest, part.nodes);
        if (meshes.length) this.riders.push(meshes);
      }
    }
  }

  get active(): boolean {
    return this.sources.length > 0;
  }
  get breaksOnImpact(): boolean {
    return this.active && this.moment === 'impact';
  }
  /** True once the break has happened. */
  get broken(): boolean {
    return this.burst;
  }

  /** The break has played out: every piece released and at rest (or long enough has passed). */
  get settled(): boolean {
    if (!this.burst) return true;
    if (this.sinceBurst > 3) return true;
    return this.bodies.every(
      (entry) => entry.delay <= 0 && (entry.body.isSleeping() || entry.speed < 0.08),
    );
  }
  private sinceBurst = 0;

  start(reduced: boolean): void {
    this.reset();
    this.reduced = reduced;
  }

  /** The hard landing: mechanical damage where the chest hit. */
  impact(): void {
    if (!this.breaksOnImpact || this.burst) return;
    this.charged = this.burst = true;
    this.sound.breakOnImpact(this.strength());
    this.detach('impact');
    for (const source of this.sources)
      this.chips(source, Math.round(source.severity * 10), 'impact');
    this.dust(8);
  }

  /**
   * Opening: progress 0..1 of its duration, delta in seconds. Call after the scene has posed the
   * chest for this frame: the energy build-up adds its tremble on top. The chest is a solid
   * object: it shakes, it never swells or squashes.
   */
  update(delta: number, progress = 0): void {
    if (this.moment === 'opening' && this.active && !this.burst && progress >= CHARGE_AT) {
      if (!this.charged) {
        this.charged = true;
        for (const source of this.sources)
          this.chips(source, Math.round(source.severity * 5), 'opening');
      }
      const charge = Math.min(1, (progress - CHARGE_AT) / (BURST_AT - CHARGE_AT)),
        strength = this.strength();
      // Burst first: fragments are cut from the chest at its real size, not mid-swell.
      if (progress < BURST_AT && !this.reduced) {
        // The chest strains against the power inside: a tremble that grows (a solid never swells).
        this.chest.position.x += (this.next() - 0.5) * charge ** 2 * 0.035 * strength;
        this.chest.position.z += (this.next() - 0.5) * charge ** 2 * 0.035 * strength;
      }
      if (progress < BURST_AT) this.sound.strain(charge);
      this.glow(charge ** 1.5 * 7 * strength);
      if (progress >= BURST_AT) {
        this.burst = true;
        this.sound.burst(strength);
        this.detach('opening');
        for (const source of this.sources)
          this.chips(source, Math.round(source.severity * 10), 'opening');
        if (!this.reduced) {
          this.shockwave();
          this.dust(6);
        }
        this.flashAge = 0;
        this.beam(1.2 + strength * 0.6, true);
      }
    }
    const step = Math.min(delta, 0.05);
    if (this.burst) this.sinceBurst += step;
    this.animateSwings(step);
    this.animateColumn(step);
    this.animateEnergy(step);
    this.stepPhysics(step);
    this.simulateParticles(step);
  }

  reset(): void {
    this.charged = this.burst = this.beamed = false;
    this.sinceBurst = 0;
    this.columnAge = Infinity;
    this.column?.removeFromParent();
    this.next = random(this.seed); // a replayed session breaks the same way
    this.flash.intensity = 0;
    this.flash.removeFromParent();
    this.flashAge = this.ringAge = Infinity;
    this.ring?.removeFromParent();
    for (const source of this.sources) for (const mesh of source.meshes) mesh.visible = true;
    for (const meshes of this.riders) for (const mesh of meshes) mesh.visible = true;
    for (const particle of this.particles) particle.mesh.removeFromParent();
    for (const body of this.bodies) body.object.removeFromParent();
    // After the bodies are gone: torn-off growth goes back where it grew.
    for (const { object, parent, matrix } of this.torn) {
      parent.add(object);
      object.matrixAutoUpdate = true;
      matrix.decompose(object.position, object.quaternion, object.scale);
    }
    this.torn.length = 0;
    for (const swing of this.swings ?? []) {
      swing.object.position.copy(swing.basePosition);
      swing.object.quaternion.copy(swing.baseRotation);
    }
    this.swings = undefined;
    this.partBodies.clear();
    for (const geometry of this.geometries) geometry.dispose();
    this.particles.length = this.bodies.length = this.geometries.length = 0;
    for (const material of this.owned) material.dispose();
    this.owned.length = 0;
    this.physics?.free();
    this.physics = undefined;
    this.accumulator = 0;
  }

  dispose(): void {
    this.reset();
    for (const item of this.shared.values()) item.dispose();
    for (const source of this.sources) {
      source.breakMaterial.map?.dispose();
      source.breakMaterial.dispose();
    }
    (this.ring?.material as Material | undefined)?.dispose();
    this.ring?.geometry.dispose();
    (this.column?.material as Material | undefined)?.dispose();
    this.column?.geometry.dispose();
    this.shared.clear();
    this.sources.length = 0;
    this.flash.dispose();
  }

  /** Union of the parts' own boxes (the visible chest without its growth). */
  private chestBox(): Box3 {
    const box = new Box3();
    for (const mesh of this.partMeshes) if (isShown(mesh)) box.union(ownBox(mesh));
    return box.isEmpty() ? new Box3().setFromObject(this.chest) : box;
  }

  private strength() {
    const detached = this.sources.filter((source) => source.detached).length;
    return 0.5 + Math.min(1, detached / Math.max(1, this.sources.length)) * 0.8;
  }

  private requirePhysics(): World {
    if (this.physics) return this.physics;
    const world = new this.engine.World({ x: 0, y: -9.81, z: 0 });
    const floor = world.createRigidBody(
      this.engine.RigidBodyDesc.fixed().setTranslation(0, this.floorY - 0.5, 0),
    );
    world.createCollider(
      this.engine.ColliderDesc.cuboid(20, 0.5, 20).setFriction(0.9).setRestitution(0.05),
      floor,
    );
    this.physics = world;
    return world;
  }

  /**
   * Every part still standing is a kinematic body that follows its mesh — the body, a lid swinging
   * open on its hinge, a latch — so loose pieces lie on them and slide off as they move. Parts that
   * broke or fell off (hidden) leave the world before the next step.
   */
  private syncParts(world: World) {
    for (const mesh of this.partMeshes) {
      let body = this.partBodies.get(mesh);
      if (!isShown(mesh)) {
        if (body) {
          world.removeRigidBody(body);
          this.partBodies.delete(mesh);
        }
        continue;
      }
      mesh.updateWorldMatrix(true, false);
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const local = mesh.geometry.boundingBox!,
        position = new Vector3(),
        rotation = new Quaternion(),
        scale = new Vector3();
      mesh.matrixWorld.decompose(position, rotation, scale);
      const centre = local.getCenter(new Vector3()).applyMatrix4(mesh.matrixWorld);
      if (!body) {
        const half = local.getSize(new Vector3()).multiply(scale).multiplyScalar(0.5);
        body = world.createRigidBody(
          this.engine.RigidBodyDesc.kinematicPositionBased()
            .setTranslation(centre.x, centre.y, centre.z)
            .setRotation(rotation),
        );
        world.createCollider(
          this.engine.ColliderDesc.cuboid(
            Math.abs(half.x),
            Math.abs(half.y),
            Math.abs(half.z),
          ).setFriction(0.8),
          body,
        );
        this.partBodies.set(mesh, body);
      } else {
        body.setNextKinematicTranslation(centre);
        body.setNextKinematicRotation(rotation);
      }
    }
  }

  private detach(moment: BreakMoment) {
    this.chest.updateWorldMatrix(true, true);
    const core = this.chestBox().getCenter(new Vector3());
    const detached = this.sources.filter((source) => source.detached);
    const gone = new Set<Mesh>([
      ...detached.flatMap((source) => source.meshes),
      ...(this.carrierDetached ? this.riders.flat() : []),
    ]);
    if (!this.reduced && gone.size) {
      const world = this.requirePhysics();
      for (const source of detached) {
        const [base, extra] = CHUNKS[source.pattern];
        for (const mesh of source.meshes)
          this.fracture(
            world,
            mesh,
            source,
            moment,
            base + Math.round(source.severity * extra),
            core,
          );
      }
      // Nothing holds the lid and latch up any more: they drop as they are.
      for (const meshes of this.riders)
        for (const mesh of meshes) this.whole(world, mesh, 'impact', core);
    }
    for (const mesh of gone) mesh.visible = false;
    // The broken parts' own bodies leave before the next step, or they would shove their fragments.
    if (this.physics) this.syncParts(this.physics);
  }

  /**
   * The energy beam: a vertical column of force rising out of the body. Everything loose above the
   * body's top — fallen-off parts, fragments, chips, snow, crystals, cobwebs, vines, leaves — is
   * thrown up and away, harder near the axis. `visible` draws the column (the intact opening has
   * its own beam light).
   */
  beam(power = 1, visible = false): void {
    if (this.beamed || this.reduced) return;
    this.beamed = true;
    this.chest.updateWorldMatrix(true, true);
    const carrier = new Box3();
    for (const mesh of this.carrierMeshes) carrier.union(ownBox(mesh));
    if (carrier.isEmpty()) carrier.copy(this.chestBox());
    const top = carrier.max.y,
      axis = carrier.getCenter(new Vector3()),
      radius = Math.max(carrier.max.x - carrier.min.x, carrier.max.z - carrier.min.z) * 0.75;
    const world = this.requirePhysics();
    this.syncParts(world);
    // Tear off loose growth sitting above the body: it becomes a rigid piece of its own.
    this.tearLoose(world, (_, position) => position.y >= top - 0.02);
    this.kick(2.2 * power);
    // Push every rigid piece in the column upwards and outwards.
    for (const entry of this.bodies) {
      const t = entry.body.translation();
      const dx = t.x - axis.x,
        dz = t.z - axis.z,
        distance = Math.hypot(dx, dz);
      if (t.y < top - 0.05 || distance > radius * 1.6) continue;
      const focus = Math.max(0.25, 1 - distance / (radius * 1.6)); // strongest on the axis
      // Same force for all: light growth is flung high and far, a heavy lid only hops and drops nearby.
      const give = 1 / (1 + entry.body.mass() * 3);
      const up = (8 + this.next() * 3) * focus * power * give,
        out = (1.8 + this.next() * 1.4) * power * give;
      // Right over the axis the push has no side to it: give it one, so pieces tip off instead of landing back.
      const angle = this.next() * Math.PI * 2,
        centred = distance < radius * 0.3;
      const nx = centred ? Math.cos(angle) : dx / distance,
        nz = centred ? Math.sin(angle) : dz / distance;
      const side = centred ? Math.max(out, 1.4) : out;
      const mass = Math.max(entry.body.mass(), 1e-6);
      entry.body.applyImpulse({ x: nx * side * mass, y: up * mass, z: nz * side * mass }, true);
      // Tumble: a tilt across the push direction, plus some spin.
      const twist = 0.5 * mass;
      entry.body.applyTorqueImpulse(
        {
          x: -nz * twist + (this.next() - 0.5) * twist * 0.4,
          y: (this.next() - 0.5) * twist * 0.6,
          z: nx * twist + (this.next() - 0.5) * twist * 0.4,
        },
        true,
      );
    }
    // Light debris rides the updraft.
    for (const particle of this.particles) {
      if (
        particle.mesh.position.y > top - 0.05 &&
        Math.hypot(particle.mesh.position.x - axis.x, particle.mesh.position.z - axis.z) <
          radius * 1.6
      ) {
        particle.velocity.y += 4 * power;
        particle.velocity.x *= 1.6;
        particle.velocity.z *= 1.6;
      }
    }
    this.sound.burst(0.35 * power);
    if (visible) this.showColumn(axis, top, radius);
  }

  /**
   * The landing jolts the chest: hanging parts (latch, vines, cobweb) swing, and loose growth near
   * the edges (snow, crystals) slides off and tumbles to the floor as real bodies. What sits in the
   * middle stays until the beam tears it away.
   */
  landed(strength = 1): void {
    if (this.reduced) return;
    this.kick(strength);
    const world = this.requirePhysics();
    this.syncParts(world);
    const torn = this.tearLoose(world, (mesh, position) => {
      if (!mesh.parent) return false;
      // Vines hang by a few tendrils: the jolt tears most of them off. Cobweb sticks.
      if (mesh.userData.growth === 'vines') return this.next() < 0.55 + strength * 0.35;
      if (mesh.geometry.type === 'PlaneGeometry') return false;
      // Off the edge: how far from the middle of the part it grows on (0 centre, 1 rim).
      const part = mesh.parent as Mesh;
      if (!part.geometry?.boundingBox) part.geometry?.computeBoundingBox();
      const box = part.geometry?.boundingBox
        ? part.geometry.boundingBox.clone().applyMatrix4(part.matrixWorld)
        : undefined;
      if (!box) return false;
      const centre = box.getCenter(new Vector3()),
        size = box.getSize(new Vector3());
      const rim = Math.max(
        Math.abs(position.x - centre.x) / (size.x / 2),
        Math.abs(position.z - centre.z) / (size.z / 2),
      );
      return rim > 0.62 && this.next() < 0.45 + strength * 0.35;
    });
    for (const entry of torn) {
      const t = entry.body.translation(),
        centre = this.chestBox().getCenter(new Vector3());
      const vine = entry.object.userData.growth === 'vines';
      // Vines peel away from their face and drift down; boxes are knocked off the rim.
      const out = new Vector3(t.x - centre.x, 0, t.z - centre.z)
        .normalize()
        .multiplyScalar((vine ? 0.25 + this.next() * 0.35 : 0.4 + this.next() * 0.7) * strength);
      const mass = Math.max(entry.body.mass(), 1e-6);
      entry.body.applyImpulse(
        {
          x: out.x * mass,
          y: (vine ? 0.1 + this.next() * 0.3 : 0.5 + this.next() * 0.9) * strength * mass,
          z: out.z * mass,
        },
        true,
      );
      entry.body.applyTorqueImpulse(
        { x: (this.next() - 0.5) * 0.3 * mass, y: 0, z: (this.next() - 0.5) * 0.3 * mass },
        true,
      );
    }
  }

  /** True while a hanging part is still swinging (the scene keeps drawing until it rests). */
  get swinging(): boolean {
    return (this.swings ?? []).some((swing) => swing.angle !== 0 || swing.velocity !== 0);
  }

  /** Jolt the hanging parts: each swing gets a push of its own. */
  kick(strength = 1): void {
    if (this.reduced) return;
    // Outwards: a jolt throws the latch away from the front wall, the spring brings it back.
    for (const swing of this.ensureSwings()) swing.velocity += (3 + this.next() * 3) * strength;
  }

  /** Loose growth (on the chest or on parts that came off) passing `keep` becomes rigid bodies. */
  private tearLoose(world: World, keep: (mesh: Mesh, position: Vector3) => boolean): Body[] {
    const loose: Mesh[] = [];
    const collect = (root: Object3D) =>
      root.traverse((object) => {
        if (object instanceof Mesh && object.userData.loose && isShown(object)) loose.push(object);
      });
    collect(this.chest);
    for (const entry of this.bodies) collect(entry.object);
    const created: Body[] = [];
    for (const mesh of loose) {
      const position = new Vector3(),
        rotation = new Quaternion(),
        scale = new Vector3();
      mesh.updateWorldMatrix(true, false);
      mesh.matrixWorld.decompose(position, rotation, scale);
      if (!keep(mesh, position)) continue;
      this.unswing(mesh);
      mesh.updateWorldMatrix(true, false);
      mesh.matrixWorld.decompose(position, rotation, scale);
      const parent = mesh.parent!;
      this.torn.push({ object: mesh, parent, matrix: mesh.matrix.clone() });
      this.world.attach(mesh);
      mesh.matrixAutoUpdate = false;
      const half = {
        x: Math.max(Math.abs(scale.x) / 2, 0.004),
        y: Math.max(Math.abs(scale.y) / 2, 0.004),
        z: Math.max(Math.abs(scale.z) / 2, 0.004),
      };
      const plane = mesh.geometry.type === 'PlaneGeometry';
      if (plane) half.z = 0.006; // thick enough not to tunnel through the floor
      this.addBody(
        world,
        mesh,
        new Matrix4().makeScale(scale.x, scale.y, scale.z),
        position,
        rotation,
        this.engine.ColliderDesc.cuboid(half.x, half.y, half.z),
        half.x * half.y * half.z * 8 * (plane ? 0.3 : 1.2),
        new Vector3(),
        'shatter',
        'opening',
        0,
      );
      const entry = this.bodies[this.bodies.length - 1]!;
      entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      // A leaf of vines or web is mostly air: it flutters down instead of dropping like a stone.
      if (plane) {
        entry.body.setLinearDamping(2.2);
        entry.body.setAngularDamping(1.2);
      }
      created.push(entry);
    }
    return created;
  }

  /**
   * Swings: hanging parts of the chest (the latch), damped springs around their top edge. Only
   * outwards: the chest is solid, nothing swings into it. Loose growth never swings — vines fall
   * off as bodies of their own, cobweb sticks.
   */
  private ensureSwings(): Swing[] {
    if (this.swings) return this.swings;
    const candidates = new Set<Mesh>(this.swingMeshes);
    const worldX = new Vector3(1, 0, 0),
      parentRotation = new Quaternion();
    this.swings = [...candidates]
      .filter((object) => object.parent)
      .map((object) => {
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        const box = object.geometry.boundingBox!,
          top = new Vector3(
            box.getCenter(new Vector3()).x,
            box.max.y,
            box.getCenter(new Vector3()).z,
          );
        object.updateMatrix();
        const pivot = top.applyMatrix4(object.matrix); // in the parent's space
        // A plane sways along its own face; a latch swings out from the front (the chest faces the camera at -Z).
        const axis =
          object.geometry.type === 'PlaneGeometry'
            ? new Vector3(1, 0, 0).applyQuaternion(object.quaternion)
            : worldX
                .clone()
                .applyQuaternion(object.parent!.getWorldQuaternion(parentRotation).invert());
        return {
          object,
          pivot,
          axis: axis.normalize(),
          basePosition: object.position.clone(),
          baseRotation: object.quaternion.clone(),
          angle: 0,
          velocity: 0,
          stiffness: object.geometry.type === 'PlaneGeometry' ? 28 : 70,
          damping: object.geometry.type === 'PlaneGeometry' ? 2.4 : 5,
        };
      });
    return this.swings;
  }

  private unswing(object: Object3D) {
    const index = this.swings?.findIndex((swing) => swing.object === object) ?? -1;
    if (index < 0) return;
    const swing = this.swings![index]!;
    object.position.copy(swing.basePosition);
    object.quaternion.copy(swing.baseRotation);
    this.swings!.splice(index, 1);
  }

  private animateSwings(delta: number) {
    if (!this.swings) return;
    const turn = new Quaternion();
    for (const swing of this.swings) {
      if (!isShown(swing.object) || (swing.angle === 0 && swing.velocity === 0)) continue;
      swing.velocity += (-swing.stiffness * swing.angle - swing.damping * swing.velocity) * delta;
      swing.angle = Math.min(1.2, swing.angle + swing.velocity * delta);
      // The front wall stops it: a +angle swings the bottom outwards (-Z), so it bounces off at 0.
      if (swing.angle < 0) {
        swing.angle = 0;
        swing.velocity = Math.abs(swing.velocity) * 0.3;
      }
      if (Math.abs(swing.angle) < 1e-4 && Math.abs(swing.velocity) < 1e-3)
        swing.angle = swing.velocity = 0;
      turn.setFromAxisAngle(swing.axis, swing.angle);
      swing.object.position
        .copy(swing.basePosition)
        .sub(swing.pivot)
        .applyQuaternion(turn)
        .add(swing.pivot);
      swing.object.quaternion.copy(turn).multiply(swing.baseRotation);
    }
  }

  /** The beam itself: an additive column shooting up from the body, then fading. */
  private showColumn(axis: Vector3, top: number, radius: number) {
    if (!this.column) {
      this.column = new Mesh(
        new CylinderGeometry(1, 1, 1, 24, 1, true),
        new MeshBasicMaterial({
          color: this.accent,
          transparent: true,
          opacity: 0.55,
          blending: AdditiveBlending,
          depthWrite: false,
          side: DoubleSide,
          toneMapped: false,
        }),
      );
      this.column.userData.chestOverlay = true;
    }
    this.column.userData.base = { x: axis.x, y: top, z: axis.z, radius: radius * 0.55 };
    this.world.add(this.column);
    this.columnAge = 0;
  }

  private animateColumn(delta: number) {
    if (!this.column || !Number.isFinite(this.columnAge)) return;
    this.columnAge += delta;
    const base = this.column.userData.base as { x: number; y: number; z: number; radius: number };
    const t = this.columnAge,
      height = Math.min(1, t / 0.18) * 6;
    this.column.scale.set(base.radius * (1 - t * 0.4), height, base.radius * (1 - t * 0.4));
    this.column.position.set(base.x, base.y + height / 2, base.z);
    (this.column.material as MeshBasicMaterial).opacity = Math.max(0, 0.55 * (1 - t / 0.9));
    if (t > 0.9) {
      this.columnAge = Infinity;
      this.column.removeFromParent();
    }
  }

  /** Solid chunks of the real mesh; `fall` keeps the part whole with its modifications. */
  private fracture(
    world: World,
    mesh: Mesh,
    source: PartSource,
    moment: BreakMoment,
    count: number,
    core: Vector3,
  ) {
    if (source.pattern === 'fall') {
      this.whole(world, mesh, moment, core);
      return;
    }
    mesh.updateWorldMatrix(true, false);
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!;
    const texel = ownBox(mesh).getSize(new Vector3()).x / 16;
    const outer = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)!;
    const height = box.max.y - box.min.y || 1;
    // A damaged part has more pieces: rust and cracks weaken it.
    const weak = weakPoints(mesh, source.damage, this.next);
    const pieces =
      count +
      (weak.length
        ? 1 + Math.round(Math.max(...source.damage.map((item) => item.intensity)) * 2)
        : 0);
    for (const cell of fractureCells(
      box,
      pieces,
      this.next,
      JITTER[source.pattern],
      source.pattern === 'crumble' ? 0.2 : 0.6,
      weak,
    )) {
      const fragment = buildFragment(mesh.geometry, cell, mesh.matrixWorld, texel);
      if (!fragment || fragment.volume < 1e-7) continue;
      this.geometries.push(fragment.geometry);
      const object = new Mesh(fragment.geometry, [outer, source.breakMaterial]);
      object.castShadow = object.receiveShadow = true;
      object.userData.chestOverlay = true;
      object.matrixAutoUpdate = false;
      this.carryOverlays(mesh, object);
      this.world.add(object);
      const away = fragment.centre.clone().sub(core);
      const delay =
        source.pattern === 'crumble'
          ? (1 - (cell.centre.y - box.min.y) / height) * 0.5 + this.next() * 0.2
          : 0;
      this.addBody(
        world,
        object,
        new Matrix4(),
        fragment.centre,
        new Quaternion(),
        this.engine.ColliderDesc.convexHull(fragment.hull),
        fragment.volume * STONE_DENSITY,
        away,
        source.pattern,
        moment,
        delay,
      );
    }
  }

  /**
   * Surface overlays of the part (rust, moss, cracks…) continue on the outer faces of its chunks:
   * the same shader, fed with the chunk's mesh-space source coordinates instead of its own.
   */
  private carryOverlays(mesh: Mesh, fragment: Mesh) {
    const hidden =
      (this.shared.get('hidden') as MeshStandardMaterial | undefined) ??
      (() => {
        const material = new MeshStandardMaterial({ visible: false });
        this.shared.set('hidden', material);
        return material;
      })();
    for (const child of mesh.children) {
      if (
        !(child instanceof Mesh) ||
        !child.userData.chestOverlay ||
        !child.visible ||
        !(child.material instanceof ShaderMaterial)
      )
        continue;
      if (!child.material.vertexShader.includes('vLocal = position')) continue;
      const material = child.material.clone();
      material.uniforms = child.material.uniforms; // shared: pulses and reveal keep animating
      material.vertexShader =
        'attribute vec3 sourcePosition; attribute vec3 sourceNormal;\n' +
        material.vertexShader.replace(
          'vLocal = position; vLocalNormal = normal;',
          'vLocal = sourcePosition; vLocalNormal = sourceNormal;',
        );
      this.owned.push(material);
      const overlay = new Mesh(fragment.geometry, [material, hidden]);
      overlay.renderOrder = child.renderOrder;
      overlay.userData.chestOverlay = true;
      fragment.add(overlay);
    }
  }

  /** A part coming off in one piece: a clone (overlays included) on a box collider. */
  private whole(world: World, mesh: Mesh, moment: BreakMoment, core: Vector3) {
    mesh.updateWorldMatrix(true, false);
    const box = ownBox(mesh),
      centre = box.getCenter(new Vector3()),
      half = box.getSize(new Vector3()).multiplyScalar(0.5);
    const object = mesh.clone(true);
    object.visible = true;
    object.matrixAutoUpdate = false;
    object.userData.chestOverlay = true;
    object.castShadow = true;
    this.world.add(object);
    // Body frame at the box centre; the clone keeps its exact world pose relative to it.
    const offset = new Matrix4()
      .makeTranslation(-centre.x, -centre.y, -centre.z)
      .multiply(mesh.matrixWorld);
    this.addBody(
      world,
      object,
      offset,
      centre,
      new Quaternion(),
      this.engine.ColliderDesc.cuboid(half.x, half.y, half.z),
      half.x * half.y * half.z * 8 * STONE_DENSITY,
      centre.clone().sub(core),
      'fall',
      moment,
      0,
    );
  }

  private addBody(
    world: World,
    object: Object3D,
    offset: Matrix4,
    at: Vector3,
    rotation: Quaternion,
    collider: ColliderDesc | null,
    mass: number,
    away: Vector3,
    pattern: BreakPattern,
    moment: BreakMoment,
    delay: number,
  ) {
    if (!collider) {
      object.removeFromParent();
      return;
    }
    // Always dynamic: a delayed piece only gets its push later. A static placeholder would be a
    // wall in the middle of the pile that stops every other piece dead.
    const body = world.createRigidBody(
      this.engine.RigidBodyDesc.dynamic()
        .setTranslation(at.x, at.y, at.z)
        .setRotation(rotation)
        .setLinearDamping(0.08)
        .setAngularDamping(0.35)
        .setCcdEnabled(true),
    );
    world.createCollider(
      collider.setDensity(STONE_DENSITY).setFriction(0.85).setRestitution(0.08),
      body,
    );
    const direction =
      away.lengthSq() < 1e-6 ? new Vector3(this.next() - 0.5, 0, this.next() - 0.5) : away.clone();
    direction.normalize();
    const r = () => this.next();
    const launch = () => {
      let velocity: Vector3;
      if (moment === 'opening') {
        // Energy from the core: speed by pattern, a lift so chunks arc instead of skating.
        // Heavy stone: a burst throws chunks a body-length or two, not across the room.
        const speed = {
          shatter: 1.8 + r() * 1.2,
          split: 1.2 + r() * 0.8,
          crumble: 0.5 + r() * 0.4,
          fall: 0.8 + r() * 0.6,
        }[pattern];
        const lift = {
          shatter: 1.6 + r() * 0.9,
          split: 1.8 + r() * 0.7,
          crumble: 0.3,
          fall: 1.2 + r() * 0.6,
        }[pattern];
        velocity = direction
          .clone()
          .multiplyScalar(speed)
          .setY(Math.max(direction.y * speed, 0) + lift);
      } else {
        // The hit: pieces give way outwards so the stack folds instead of standing like masonry;
        // gravity does the rest.
        velocity = direction
          .clone()
          .setY(0)
          .normalize()
          .multiplyScalar(
            { shatter: 1.9, split: 1.7, crumble: 1.5, fall: 1 }[pattern] * (0.7 + r() * 0.6),
          )
          .setY(0.3 + r() * 0.6);
      }
      const total = Math.max(body.mass(), 1e-6); // the collider's real mass, not an estimate
      body.applyImpulse(
        { x: velocity.x * total, y: velocity.y * total, z: velocity.z * total },
        true,
      );
      // Topple: a tilt across the outward direction, so chunks fall over rather than slide.
      const twist = (moment === 'opening' ? 0.08 : 0.22) * total;
      body.applyTorqueImpulse(
        {
          x: (-direction.z + (r() - 0.5) * 0.6) * twist,
          y: (r() - 0.5) * twist * 0.5,
          z: (direction.x + (r() - 0.5) * 0.6) * twist,
        },
        true,
      );
    };
    if (delay <= 0) launch();
    const entry = { object, offset, body, delay, launch, mass, speed: 0 };
    this.bodies.push(entry);
    this.sync(entry);
  }

  private stepPhysics(delta: number) {
    if (!this.physics) return;
    this.syncParts(this.physics);
    let released = 0;
    for (const body of this.bodies)
      if (body.delay > 0 && (body.delay -= delta) <= 0) {
        body.launch();
        released++;
      }
    if (released) this.sound.crumble(Math.min(1, released / 3));
    this.accumulator += delta;
    while (this.accumulator >= STEP) {
      this.physics.timestep = STEP;
      this.physics.step();
      this.accumulator -= STEP;
    }
    for (const body of this.bodies) {
      this.sync(body);
      // A sudden loss of speed is a hit (floor, another chunk, the body): that is what we hear.
      const v = body.body.linvel(),
        speed = Math.hypot(v.x, v.y, v.z);
      if (body.speed - speed > 0.9) this.sound.thud(body.mass, body.speed - speed);
      body.speed = speed;
    }
  }

  private sync({ object, offset, body }: Body) {
    const t = body.translation(),
      q = body.rotation();
    object.matrix
      .compose(new Vector3(t.x, t.y, t.z), new Quaternion(q.x, q.y, q.z, q.w), new Vector3(1, 1, 1))
      .multiply(offset);
    object.matrixWorldNeedsUpdate = true;
  }

  /** Small debris from the surface: stone grit plus whatever the modifications are made of. */
  private chips(source: PartSource, count: number, moment: BreakMoment) {
    if (this.reduced || count <= 0) return;
    this.chest.updateWorldMatrix(true, true);
    const core = this.chestBox().getCenter(new Vector3());
    const total = source.debris.reduce((sum, item) => sum + item.weight, 0);
    for (let index = 0; index < count; index++) {
      const mesh = source.meshes[Math.floor(this.next() * source.meshes.length)]!;
      const box = ownBox(mesh),
        size = box.getSize(new Vector3());
      const unit = Math.max(size.x, size.z) / 16; // one model texel
      let pick = this.next() * total,
        debris = source.debris[0]!.style;
      for (const item of source.debris) {
        pick -= item.weight;
        if (pick <= 0) {
          debris = item.style;
          break;
        }
      }
      const point = surfacePoint(box, size, this.next);
      const edge = unit * (1 + Math.floor(this.next() * 2));
      const away = point.clone().sub(core).normalize();
      if (debris.shape === 'chip' || debris.shape === 'shard' || debris.shape === 'flake') {
        const scale = RIGID_SCALE[debris.shape];
        const object = new Mesh(this.box(), this.material(debris));
        object.castShadow = true;
        object.userData.chestOverlay = true;
        object.matrixAutoUpdate = false;
        this.world.add(object);
        const half = {
          x: (edge * scale[0]) / 2,
          y: (edge * scale[1]) / 2,
          z: (edge * scale[2]) / 2,
        };
        const offset = new Matrix4().makeScale(edge * scale[0], edge * scale[1], edge * scale[2]);
        const tilt = new Quaternion().setFromAxisAngle(
          new Vector3(this.next(), this.next(), this.next()).normalize(),
          this.next() * 6,
        );
        this.addBody(
          this.requirePhysics(),
          object,
          offset,
          point,
          tilt,
          this.engine.ColliderDesc.cuboid(half.x, half.y, half.z),
          half.x * half.y * half.z * 8 * STONE_DENSITY,
          away,
          'shatter',
          moment,
          0,
        );
      } else {
        const light = LIGHT[debris.shape];
        const object = new Mesh(
          debris.shape === 'leaf' ? this.plane() : this.box(),
          this.material(debris),
        );
        object.scale.setScalar(edge * light.scale);
        object.position.copy(point);
        object.userData.chestOverlay = true;
        this.world.add(object);
        const velocity = away
          .multiplyScalar((moment === 'opening' ? 1.6 : 0.7) * (0.6 + this.next()))
          .add(new Vector3(0, 0.8, 0));
        this.particles.push({
          mesh: object,
          velocity,
          spin: new Vector3(this.next() - 0.5, this.next() - 0.5, this.next() - 0.5).multiplyScalar(
            8,
          ),
          shape: debris.shape,
          size: edge * light.scale,
          age: 0,
          life: light.life * (0.75 + this.next() * 0.5),
        });
      }
    }
  }

  private simulateParticles(delta: number) {
    for (let index = this.particles.length - 1; index >= 0; index--) {
      const particle = this.particles[index]!,
        light = LIGHT[particle.shape as keyof typeof LIGHT];
      particle.age += delta;
      particle.velocity.y -= light.gravity * delta;
      particle.velocity.multiplyScalar(Math.max(0, 1 - light.drag * delta));
      particle.mesh.position.addScaledVector(particle.velocity, delta);
      particle.mesh.rotation.x += particle.spin.x * delta;
      particle.mesh.rotation.y += particle.spin.y * delta;
      if (particle.mesh.position.y < this.floorY + particle.size * 0.3) {
        particle.mesh.position.y = this.floorY + particle.size * 0.3;
        particle.velocity.multiplyScalar(0.3);
        particle.spin.multiplyScalar(0.3);
      }
      const remaining = particle.life - particle.age;
      if (particle.shape === 'puff') {
        particle.mesh.scale.multiplyScalar(1 + delta * 0.8);
        (particle.mesh.material as MeshStandardMaterial).opacity = Math.max(
          0,
          (0.2 * remaining) / particle.life,
        );
      } else if (remaining < 0.4)
        particle.mesh.scale.multiplyScalar(Math.max(0.01, 1 - delta / Math.max(remaining, 0.02)));
      if (remaining <= 0) {
        particle.mesh.removeFromParent();
        this.particles.splice(index, 1);
      }
    }
  }

  private glow(intensity: number) {
    if (!this.flash.parent) this.world.add(this.flash);
    this.chest.updateWorldMatrix(true, false);
    this.chestBox().getCenter(this.flash.position);
    this.flash.intensity = this.reduced ? 0 : intensity;
  }

  /** Energy release: a bright flash at the core and a ring running along the floor. */
  private shockwave() {
    this.chest.updateWorldMatrix(true, false);
    const centre = this.chestBox().getCenter(new Vector3());
    if (!this.ring) {
      this.ring = new Mesh(
        new RingGeometry(0.9, 1, 64),
        new MeshBasicMaterial({
          color: this.accent,
          transparent: true,
          opacity: 0.7,
          blending: AdditiveBlending,
          depthWrite: false,
          side: DoubleSide,
          toneMapped: false,
        }),
      );
      this.ring.rotation.x = -Math.PI / 2;
      this.ring.userData.chestOverlay = true;
    }
    this.ring.position.set(centre.x, this.floorY + 0.01, centre.z);
    this.world.add(this.ring);
    this.ringAge = 0;
  }

  private animateEnergy(delta: number) {
    if (Number.isFinite(this.flashAge)) {
      this.flashAge += delta;
      this.flash.intensity = this.reduced ? 0 : 55 * Math.exp(-this.flashAge * 5);
      if (this.flashAge > 1.2) {
        this.flashAge = Infinity;
        this.flash.intensity = 0;
      }
    }
    if (this.ring && Number.isFinite(this.ringAge)) {
      this.ringAge += delta;
      this.ring.scale.setScalar(0.2 + this.ringAge * 5);
      (this.ring.material as MeshBasicMaterial).opacity = Math.max(
        0,
        0.7 * (1 - this.ringAge / 0.7),
      );
      if (this.ringAge > 0.7) {
        this.ringAge = Infinity;
        this.ring.removeFromParent();
      }
    }
  }

  /** Soft dust rolling out along the floor. */
  private dust(count: number) {
    if (this.reduced) return;
    this.chest.updateWorldMatrix(true, false);
    const box = this.chestBox(),
      size = box.getSize(new Vector3());
    const unit = Math.max(size.x, size.z) / 16;
    for (let index = 0; index < count; index++) {
      const object = new Mesh(
        this.box(),
        this.material({ shape: 'puff', color: '#7d8584', share: 1 }),
      );
      const angle = this.next() * Math.PI * 2;
      object.position.set(
        box.min.x + size.x * this.next(),
        this.floorY + unit * 1.5,
        box.min.z + size.z * this.next(),
      );
      object.scale.setScalar(unit * 2);
      object.userData.chestOverlay = true;
      this.world.add(object);
      this.particles.push({
        mesh: object,
        velocity: new Vector3(Math.cos(angle), 0.2, Math.sin(angle)).multiplyScalar(1.2),
        spin: new Vector3(),
        shape: 'puff',
        size: unit * 3,
        age: 0,
        life: 1.3 + this.next() * 0.6,
      });
    }
  }

  /** Broken stone: the part's own colour, darker and grainy, on the chest's texel grid. */
  private breakMaterial(stone: Color, seed: string): MeshStandardMaterial {
    const next = random(hash(seed) ^ this.seed),
      size = 16,
      pixels = new Uint8Array(size * size * 4);
    const base = stone.clone().multiplyScalar(0.55);
    for (let index = 0; index < size * size; index++) {
      const shade = 0.55 + next() * 0.55 + (next() < 0.08 ? 0.35 : 0);
      const color = base.clone().multiplyScalar(shade).convertLinearToSRGB();
      pixels[index * 4] = Math.min(255, color.r * 255);
      pixels[index * 4 + 1] = Math.min(255, color.g * 255);
      pixels[index * 4 + 2] = Math.min(255, color.b * 255);
      pixels[index * 4 + 3] = 255;
    }
    const map = new DataTexture(pixels, size, size, RGBAFormat);
    map.magFilter = map.minFilter = NearestFilter;
    map.wrapS = map.wrapT = RepeatWrapping;
    map.colorSpace = SRGBColorSpace;
    map.needsUpdate = true;
    return new MeshStandardMaterial({ map, roughness: 0.95, flatShading: true });
  }

  private box() {
    let geometry = this.shared.get('box') as BufferGeometry | undefined;
    if (!geometry) {
      geometry = new BoxGeometry(1, 1, 1);
      this.shared.set('box', geometry);
    }
    return geometry;
  }
  private plane() {
    let geometry = this.shared.get('plane') as BufferGeometry | undefined;
    if (!geometry) {
      geometry = new PlaneGeometry(1, 1);
      this.shared.set('plane', geometry);
    }
    return geometry;
  }

  private material(debris: DebrisStyle) {
    if (debris.shape === 'puff') {
      // Puffs fade individually, so each gets its own material.
      const material = new MeshStandardMaterial({
        color: debris.color,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        roughness: 1,
      });
      this.owned.push(material);
      return material;
    }
    const key = `${debris.shape}:${debris.color}`;
    let material = this.shared.get(key) as MeshStandardMaterial | undefined;
    if (!material) {
      const glowing =
        debris.shape === 'spark' ||
        (debris.shape === 'shard' && new Color(debris.color).getHSL({ h: 0, s: 0, l: 0 }).s > 0.3);
      material = new MeshStandardMaterial({
        color: debris.color,
        roughness: 0.85,
        side: debris.shape === 'leaf' ? DoubleSide : undefined,
        emissive: glowing ? debris.color : '#000000',
        emissiveIntensity: debris.shape === 'spark' ? 1.6 : 0.35,
      });
      this.shared.set(key, material);
    }
    return material;
  }
}

/**
 * Points on the part's surface where its damage is: the same masks and projection the overlays use
 * (chest-modification-layers.ts), so the break follows the rust or cracks the player can see.
 */
function weakPoints(
  mesh: Mesh,
  damage: readonly ResolvedModification[],
  next: () => number,
): Vector3[] {
  if (!damage.length) return [];
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox!,
    size = box.getSize(new Vector3());
  const masks = damage.map((item) => ({
    item,
    pixels:
      item.definition.kind === 'wear'
        ? wearPattern(item.definition.style, item.seed)
        : item.definition.kind === 'fracture'
          ? fracturePattern(item.definition.style, item.seed)
          : undefined,
  }));
  const result: Vector3[] = [];
  for (let attempt = 0; attempt < 600 && result.length < 24; attempt++) {
    const point = surfacePoint(box, size, next);
    const axis = [
      point.x === box.min.x || point.x === box.max.x,
      point.y === box.max.y,
      true,
    ].indexOf(true);
    const [u, v] =
      axis === 0 ? [point.z, point.y] : axis === 1 ? [point.x, point.z] : [point.x, point.y];
    for (const { item, pixels } of masks) {
      if (!pixels) continue;
      const scale = item.definition.style.scale * 0.5;
      const x = Math.floor(((((u * scale) % 1) + 1) % 1) * PATTERN_SIZE),
        y = Math.floor(((((v * scale) % 1) + 1) % 1) * PATTERN_SIZE);
      const index = (y * PATTERN_SIZE + x) * 4;
      if (pixels[index + 3] && pixels[index]! / 255 <= item.intensity) {
        result.push(point);
        break;
      }
    }
  }
  return result;
}

/**
 * The part's own extent: its geometry only. Box3.setFromObject would include children — vines and
 * cobwebs hanging far below a lid made it a huge invisible block resting on its own growth.
 */
function ownBox(mesh: Mesh): Box3 {
  mesh.updateWorldMatrix(true, false);
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
}

/** Visible all the way up its parents (hidden parts take their loose growth with them). */
function isShown(object: Object3D): boolean {
  for (let current: Object3D | null = object; current; current = current.parent)
    if (!current.visible) return false;
  return true;
}

/** A random point on an outer face of the box (not the bottom). */
function surfacePoint(box: Box3, size: Vector3, next: () => number): Vector3 {
  const face = Math.floor(next() * 5),
    u = next(),
    v = next();
  const point = new Vector3(box.min.x + size.x * u, box.min.y + size.y * v, box.min.z + size.z * u);
  if (face === 0) point.y = box.max.y;
  else if (face === 1) point.x = box.min.x;
  else if (face === 2) point.x = box.max.x;
  else if (face === 3) point.z = box.min.z;
  else point.z = box.max.z;
  return point;
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++)
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
}

/** Average colour of the texture area this mesh's UVs cover, so debris looks like its own stone. */
function averageColor(mesh: Mesh): Color {
  const material = (
    Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  ) as MeshStandardMaterial;
  const fallback = material?.color?.clone() ?? new Color('#343342');
  const image = material?.map?.image as
    (CanvasImageSource & { width: number; height: number }) | undefined;
  const uv = mesh.geometry.getAttribute('uv');
  if (!image || !uv || typeof document === 'undefined') return fallback;
  try {
    let u0 = 1,
      v0 = 1,
      u1 = 0,
      v1 = 0;
    for (let index = 0; index < uv.count; index++) {
      u0 = Math.min(u0, uv.getX(index));
      u1 = Math.max(u1, uv.getX(index));
      v0 = Math.min(v0, uv.getY(index));
      v1 = Math.max(v1, uv.getY(index));
    }
    const flip = material.map!.flipY;
    const sx = u0 * image.width,
      sw = Math.max(1, (u1 - u0) * image.width);
    const sy = (flip ? 1 - v1 : v0) * image.height,
      sh = Math.max(1, (v1 - v0) * image.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return fallback;
    context.drawImage(image, sx, sy, sw, sh, 0, 0, 8, 8);
    const data = context.getImageData(0, 0, 8, 8).data;
    let r = 0,
      g = 0,
      b = 0,
      n = 0;
    for (let index = 0; index < data.length; index += 4)
      if (data[index + 3]! > 128) {
        r += data[index]!;
        g += data[index + 1]!;
        b += data[index + 2]!;
        n++;
      }
    return n
      ? new Color().setRGB(r / n / 255, g / n / 255, b / n / 255, 'srgb').multiply(fallback)
      : fallback;
  } catch {
    return fallback;
  }
}
