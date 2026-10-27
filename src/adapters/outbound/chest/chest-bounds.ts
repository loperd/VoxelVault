import type { BoxCollider, Vec3 } from './physics-world-port.ts';

export interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** The chest's width in its scene's units: one block of whatever world it stands in. */
export const CHEST_WIDTH = 1.7;

/** Normalizes the closed body and lid together; the hidden key is not a collider. */
export function normalizeChestBounds(
  bounds: readonly Bounds[],
  targetWidth = CHEST_WIDTH,
): {
  readonly scale: number;
  readonly center: Vec3;
  readonly colliders: readonly BoxCollider[];
} {
  if (bounds.length === 0 || !Number.isFinite(targetWidth) || targetWidth <= 0) {
    throw new Error('Closed chest bounds and a positive target width are required.');
  }
  for (const box of bounds) {
    for (const axis of ['x', 'y', 'z'] as const) {
      if (
        !Number.isFinite(box.min[axis]) ||
        !Number.isFinite(box.max[axis]) ||
        box.max[axis] <= box.min[axis]
      ) {
        throw new Error('Chest bounds must be finite and have positive volume.');
      }
    }
  }
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const box of bounds)
    for (const axis of ['x', 'y', 'z'] as const) {
      min[axis] = Math.min(min[axis], box.min[axis]);
      max[axis] = Math.max(max[axis], box.max[axis]);
    }
  const scale = targetWidth / (max.x - min.x);
  const center = Object.freeze({
    x: (min.x + max.x) / 2,
    y: (min.y + max.y) / 2,
    z: (min.z + max.z) / 2,
  });
  const colliders = bounds.map((box) =>
    Object.freeze({
      center: Object.freeze({
        x: ((box.min.x + box.max.x) / 2 - center.x) * scale,
        y: ((box.min.y + box.max.y) / 2 - center.y) * scale,
        z: ((box.min.z + box.max.z) / 2 - center.z) * scale,
      }),
      halfExtents: Object.freeze({
        x: ((box.max.x - box.min.x) / 2) * scale,
        y: ((box.max.y - box.min.y) / 2) * scale,
        z: ((box.max.z - box.min.z) / 2) * scale,
      }),
    }),
  );
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !Object.values(center).every(Number.isFinite) ||
    colliders.some((box) =>
      [...Object.values(box.center), ...Object.values(box.halfExtents)].some(
        (value) => !Number.isFinite(value),
      ),
    )
  ) {
    throw new Error('Chest normalization exceeds the supported numeric range.');
  }
  return Object.freeze({ scale, center, colliders: Object.freeze(colliders) });
}
