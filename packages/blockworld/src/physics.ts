import type RapierEngine from '@dimforge/rapier3d-compat';
import type { RigidBody, World } from '@dimforge/rapier3d-compat';
import type { BlockRegistry } from './blocks.ts';
import type { BlockWorld } from './world.ts';

/**
 * The world's physics, in blocks (a block is a metre, gravity 9.81): the ground is the world's own
 * solid blocks, and things put into the world — a chest, say — are bodies in it. The world can push
 * them (a blast). There is one clock: whoever moves first in a frame — the world's loop or a guest
 * drawing itself — brings the simulation up to now, in fixed steps, and nobody steps it twice.
 */
export type Vec = readonly [number, number, number];
export interface BodyPose {
  readonly position: Vec;
  readonly rotation: readonly [number, number, number, number];
}
/** A box of a body, in blocks, relative to the body. */
export interface BodyBox {
  readonly center: Vec;
  readonly half: Vec;
}
export interface BodySpec {
  readonly boxes: readonly BodyBox[];
  readonly pose: BodyPose;
  readonly restitution?: number;
  readonly friction?: number;
}
export interface Body {
  pose(): BodyPose;
  sleeping(): boolean;
  /** Put it somewhere at rest (velocities cleared). */
  place(pose: BodyPose): void;
  /**
   * Held: the body stays exactly where it is put, whatever happens (it hangs in the air, blasts
   * pass it by). Let go: it moves under gravity and everything else again.
   */
  hold(held: boolean): void;
  remove(): void;
}

export interface PhysicsGround {
  /** Solid blocks within `radius` of `around` (x, z) become the ground. */
  readonly blocks?: {
    readonly world: BlockWorld;
    readonly registry: BlockRegistry;
    readonly around: readonly [number, number];
    readonly radius: number;
  };
  /** Boxes of the world's own solid things (a world built of meshes, not of a `BlockWorld`). */
  readonly boxes?: readonly { readonly center: Vec; readonly half: Vec }[];
  /** A flat floor at this height, everywhere (for a world with no blocks to stand on). */
  readonly floor?: number;
}

const STEP = 1 / 60,
  MAX_GAP = 0.1;
let initialization: Promise<void> | undefined;
let RAPIER: typeof RapierEngine;

/** For effects with their own simulation, after awaiting physicsReady(). */
export function physicsEngine(): typeof RapierEngine {
  if (!RAPIER) throw new Error('Await physicsReady() before creating physics effects.');
  return RAPIER;
}

/** Rapier's engine, loaded once for the page. */
export function physicsReady(): Promise<void> {
  return (initialization ??= import('@dimforge/rapier3d-compat')
    .then(async ({ default: engine }) => {
      await engine.init();
      RAPIER = engine;
    })
    .catch((error) => {
      initialization = undefined;
      throw error;
    }));
}

export class WorldPhysics {
  private world: World | undefined;
  private readonly bodies = new Set<RigidBody>();
  private clock: number | undefined;
  private spare = 0;

  private constructor(world: World) {
    this.world = world;
  }

  static async create(ground: PhysicsGround, gravity: Vec = [0, -9.81, 0]): Promise<WorldPhysics> {
    await physicsReady();
    const world = new RAPIER.World({ x: gravity[0], y: gravity[1], z: gravity[2] });
    const physics = new WorldPhysics(world);
    try {
      const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      const solid = (cx: number, cy: number, cz: number, half: Vec) =>
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(...half)
            .setTranslation(cx, cy, cz)
            .setFriction(1)
            .setRestitution(1)
            .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
            .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply),
          fixed,
        );
      if (ground.floor !== undefined) solid(0, ground.floor - 0.5, 0, [200, 0.5, 200]);
      if (ground.blocks) groundBlocks(ground.blocks, solid);
      for (const box of ground.boxes ?? []) solid(...box.center, box.half);
    } catch (error) {
      physics.dispose();
      throw error;
    }
    return physics;
  }

  add(spec: BodySpec): Body {
    const world = this.require();
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setLinearDamping(0.1)
        .setAngularDamping(0.2)
        .setCanSleep(true)
        .setCcdEnabled(true),
    );
    for (const box of spec.boxes) {
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(...box.half)
          .setTranslation(...box.center)
          .setFriction(spec.friction ?? 1)
          .setRestitution(spec.restitution ?? 0.3)
          .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
          .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply),
        body,
      );
    }
    this.bodies.add(body);
    const place = (pose: BodyPose) => {
      const [x, y, z, w] = pose.rotation;
      body.setTranslation({ x: pose.position[0], y: pose.position[1], z: pose.position[2] }, true);
      body.setRotation({ x, y, z, w }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    };
    place(spec.pose);
    return {
      pose: () => {
        const t = body.translation(),
          r = body.rotation();
        return { position: [t.x, t.y, t.z], rotation: [r.x, r.y, r.z, r.w] };
      },
      sleeping: () => body.isSleeping(),
      place,
      hold: (held) => {
        body.setBodyType(
          held ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic,
          true,
        );
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      },
      remove: () => {
        if (this.bodies.delete(body)) this.world?.removeRigidBody(body);
      },
    };
  }

  /** Bring the simulation up to `now` (ms) in fixed steps; a long pause is not made up for. */
  sync(now: number): void {
    if (!this.world) return;
    if (this.clock === undefined) {
      this.clock = now;
      return;
    }
    const gap = Math.min(MAX_GAP, Math.max(0, (now - this.clock) / 1000));
    this.clock = now;
    this.spare += gap;
    while (this.spare >= STEP) {
      this.world.step();
      this.spare -= STEP;
    }
  }

  /** Run until everything rests (or `seconds` of simulated time pass): for a still picture. */
  settle(seconds = 15): void {
    const world = this.require();
    for (let t = 0; t < seconds && this.awake(); t += STEP) world.step();
  }

  /** Is anything still moving? */
  awake(): boolean {
    for (const body of this.bodies) if (body.isDynamic() && !body.isSleeping()) return true;
    return false;
  }

  /** A blast at a point: bodies within `radius` are thrown away from it and up, harder the closer. */
  blast(at: Vec, strength: number, radius: number): void {
    for (const body of this.bodies) {
      if (!body.isDynamic()) continue;
      const p = body.translation(),
        dx = p.x - at[0],
        dy = p.y - at[1],
        dz = p.z - at[2],
        d = Math.hypot(dx, dy, dz);
      if (d >= radius) continue;
      const push = strength * body.mass() * (1 - d / radius),
        n = d || 1;
      body.applyImpulse(
        { x: (dx / n) * push, y: (Math.max(0, dy) / n + 0.6) * push, z: (dz / n) * push },
        true,
      );
      body.applyTorqueImpulse(
        {
          x: (Math.random() - 0.5) * push * 0.2,
          y: (Math.random() - 0.5) * push * 0.2,
          z: (Math.random() - 0.5) * push * 0.2,
        },
        true,
      );
    }
  }

  dispose(): void {
    const world = this.world;
    this.world = undefined;
    this.bodies.clear();
    world?.free();
  }

  private require(): World {
    if (!this.world) throw new Error('The world physics has been disposed.');
    return this.world;
  }
}

/** Every solid block near the spot that has an open side becomes a box of ground. */
function groundBlocks(
  ground: NonNullable<PhysicsGround['blocks']>,
  solid: (x: number, y: number, z: number, half: Vec) => void,
): void {
  const { world, registry, around, radius } = ground,
    [ox, oy, oz] = world.origin;
  const opaque = (x: number, y: number, z: number) =>
    world.inside(x, y, z) && (registry.get(world.get(x, y, z))?.opaque ?? false);
  const cx = Math.floor(around[0] - ox),
    cz = Math.floor(around[1] - oz),
    r = Math.ceil(radius);
  for (let x = cx - r; x <= cx + r; x++)
    for (let z = cz - r; z <= cz + r; z++) {
      if (Math.hypot(x - cx, z - cz) > radius) continue;
      for (let y = 0; y < world.sy; y++) {
        if (!opaque(x, y, z)) continue;
        if (
          opaque(x + 1, y, z) &&
          opaque(x - 1, y, z) &&
          opaque(x, y + 1, z) &&
          opaque(x, y - 1, z) &&
          opaque(x, y, z + 1) &&
          opaque(x, y, z - 1)
        )
          continue;
        solid(x + ox + 0.5, y + oy + 0.5, z + oz + 0.5, [0.5, 0.5, 0.5]);
      }
    }
}
