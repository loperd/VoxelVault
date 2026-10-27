import type {
  Body,
  GuestWorld,
  Vec,
  WorldPhysics,
} from '../../../../packages/blockworld/src/index.ts';
import { Quaternion, Vector3 } from 'three';
import type { BoxCollider, PhysicsWorldPort, Pose } from './physics-world-port.ts';

/**
 * The chest's body in the world's physics. The chest thinks in its own units (its floor at y 0,
 * `unit` of them to a block); the world's physics is in blocks, with the chest's floor on the
 * anchor block. This converts both ways. The world's clock moves the simulation: `step` only asks
 * the world to bring it up to now, so the chest and the world never step it twice.
 */
const UP = new Vector3(0, 1, 0);

export class WorldBodyPhysics implements PhysicsWorldPort {
  private readonly physics: WorldPhysics;
  private readonly world: GuestWorld;
  private readonly anchor: Vec;
  private readonly unit: number;
  /** The world turned the chest to show its front: chest space → world space and back. */
  private readonly turn: Quaternion;
  private readonly back: Quaternion;
  private body?: Body;
  private last?: { colliders: readonly BoxCollider[]; pose: Pose };
  private moving = true;

  constructor(physics: WorldPhysics, world: GuestWorld, unit: number) {
    this.physics = physics;
    this.world = world;
    this.anchor = world.anchor;
    this.unit = unit;
    this.turn = new Quaternion().setFromAxisAngle(UP, world.turn);
    this.back = this.turn.clone().invert();
  }

  resetChest(colliders: readonly BoxCollider[], pose: Pose): void {
    this.body?.remove();
    const u = this.unit;
    // Boxes are relative to the body: only scaled; the body's rotation carries the turn.
    this.body = this.physics.add({
      boxes: colliders.map((box) => ({
        center: [box.center.x / u, box.center.y / u, box.center.z / u],
        half: [box.halfExtents.x / u, box.halfExtents.y / u, box.halfExtents.z / u],
      })),
      pose: this.toWorld(pose),
      restitution: 0.3,
      friction: 1,
    });
    this.last = { colliders, pose };
    this.moving = true;
  }

  /** Bring the world's simulation up to now; the step length is the world's business. */
  step(): void {
    this.world.sync();
  }

  settle(): void {
    this.physics.settle();
  }

  setChestMoving(moving: boolean): void {
    if (!this.body) throw new Error('The chest body has not been created.');
    this.body.hold(!moving);
    this.moving = moving;
  }

  readChestPose(): Pose {
    if (!this.body) throw new Error('The chest body has not been created.');
    const {
        position: [x, y, z],
        rotation: [rx, ry, rz, rw],
      } = this.body.pose(),
      a = this.anchor;
    const p = new Vector3(x - a[0], y - a[1], z - a[2])
      .applyQuaternion(this.back)
      .multiplyScalar(this.unit);
    const r = this.back.clone().multiply(new Quaternion(rx, ry, rz, rw));
    return { position: { x: p.x, y: p.y, z: p.z }, rotation: { x: r.x, y: r.y, z: r.z, w: r.w } };
  }

  isChestSleeping(): boolean {
    return this.body?.sleeping() ?? false;
  }

  diagnostics(): { bodies: number; colliders: number } {
    return { bodies: this.body ? 1 : 0, colliders: this.last?.colliders.length ?? 0 };
  }

  /** The chest moves to another world: where it was, and whether it hung or moved, in the new one. */
  carryOver(): { pose: Pose; moving: boolean } | undefined {
    const pose = this.body ? this.readChestPose() : this.last?.pose;
    return pose && { pose, moving: this.moving };
  }

  dispose(): void {
    this.body?.remove();
    this.body = undefined;
  }

  private toWorld(pose: Pose): {
    position: Vec;
    rotation: readonly [number, number, number, number];
  } {
    const a = this.anchor,
      { position: p, rotation: r } = pose;
    const v = new Vector3(p.x, p.y, p.z).divideScalar(this.unit).applyQuaternion(this.turn);
    const q = this.turn.clone().multiply(new Quaternion(r.x, r.y, r.z, r.w));
    return { position: [v.x + a[0], v.y + a[1], v.z + a[2]], rotation: [q.x, q.y, q.z, q.w] };
  }
}
