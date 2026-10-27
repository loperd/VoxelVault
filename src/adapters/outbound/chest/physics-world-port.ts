export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}
export interface Quat extends Vec3 {
  readonly w: number;
}
export interface Pose {
  readonly position: Vec3;
  readonly rotation: Quat;
}
export interface BoxCollider {
  readonly center: Vec3;
  readonly halfExtents: Vec3;
}

export interface PhysicsWorldPort {
  resetChest(colliders: readonly BoxCollider[], pose: Pose): void;
  step(deltaSeconds: number): void;
  /** Run until the chest rests (a still picture, reduced motion). */
  settle(): void;
  /** Off: the chest hangs exactly where it is (in the air, untouched by anything). On: it falls. */
  setChestMoving(moving: boolean): void;
  readChestPose(): Pose;
  isChestSleeping(): boolean;
  diagnostics(): { readonly bodies: number; readonly colliders: number };
  dispose(): void;
}
