import RAPIER, { type RigidBody, type World } from '@dimforge/rapier3d-compat';
import { waitFor } from '../../../application/cancellation.ts';
import { assertChestDefinition, PHYSICS_CONFIG } from './physics-config.ts';
import type { BoxCollider, PhysicsWorldPort, Pose } from './physics-world-port.ts';

let initialization: Promise<void> | undefined;

export async function createRapierPhysicsWorld(signal: AbortSignal): Promise<PhysicsWorldPort> {
  signal.throwIfAborted();
  const ready = (initialization ??= initializeRapier().catch((error) => {
    initialization = undefined;
    throw error;
  }));
  await waitFor(ready, signal);
  signal.throwIfAborted();
  return new RapierPhysicsWorld();
}

async function initializeRapier(): Promise<void> {
  await RAPIER.init();
}

class RapierPhysicsWorld implements PhysicsWorldPort {
  private world?: World;
  private chest?: RigidBody;

  constructor() {
    const world = new RAPIER.World(PHYSICS_CONFIG.gravity);
    try {
      const floor = PHYSICS_CONFIG.floorHalfExtents;
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(0, -floor.y, 0),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(floor.x, floor.y, floor.z)
          .setFriction(PHYSICS_CONFIG.friction)
          .setRestitution(PHYSICS_CONFIG.floorRestitution)
          .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
          .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply),
        body,
      );
      this.world = world;
    } catch (error) {
      world.free();
      throw error;
    }
  }

  resetChest(colliders: readonly BoxCollider[], pose: Pose): void {
    assertChestDefinition(colliders, pose);
    const world = this.requireWorld();
    if (this.chest) {
      world.removeRigidBody(this.chest);
      this.chest = undefined;
    }
    const { position, rotation } = pose;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setRotation(rotation)
        .setLinearDamping(0.1)
        .setAngularDamping(0.2)
        .setCanSleep(true)
        .setCcdEnabled(true),
    );
    try {
      for (const { center, halfExtents } of colliders) {
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
            .setTranslation(center.x, center.y, center.z)
            .setFriction(PHYSICS_CONFIG.friction)
            .setRestitution(PHYSICS_CONFIG.chestRestitution)
            .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
            .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply),
          body,
        );
      }
      this.chest = body;
    } catch (error) {
      world.removeRigidBody(body);
      throw error;
    }
  }

  step(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0 || deltaSeconds > 0.1) {
      throw new Error('Physics steps must be positive and no larger than 0.1 seconds.');
    }
    const world = this.requireWorld();
    world.timestep = deltaSeconds;
    world.step();
  }

  setChestMoving(moving: boolean): void {
    const chest = this.chest;
    if (!chest) throw new Error('The chest body has not been created.');
    chest.setBodyType(
      moving ? RAPIER.RigidBodyType.Dynamic : RAPIER.RigidBodyType.KinematicPositionBased,
      true,
    );
    chest.setLinvel({ x: 0, y: 0, z: 0 }, true);
    chest.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  settle(): void {
    for (let frame = 0; frame < 900 && !this.isChestSleeping(); frame++) this.step(1 / 60);
  }

  readChestPose(): Pose {
    this.requireWorld();
    if (!this.chest) throw new Error('The chest body has not been created.');
    return { position: { ...this.chest.translation() }, rotation: { ...this.chest.rotation() } };
  }

  diagnostics(): { bodies: number; colliders: number } {
    return { bodies: this.world?.bodies.len() ?? 0, colliders: this.world?.colliders.len() ?? 0 };
  }

  isChestSleeping(): boolean {
    this.requireWorld();
    return this.chest?.isSleeping() ?? false;
  }

  dispose(): void {
    const world = this.world;
    this.world = undefined;
    this.chest = undefined;
    world?.free();
  }

  private requireWorld(): World {
    if (!this.world) throw new Error('The physics world has been disposed.');
    return this.world;
  }
}
