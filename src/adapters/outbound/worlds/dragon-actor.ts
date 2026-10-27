import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import type { Living } from '../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../application/ports/chest-handles.ts';

export interface DragonModel {
  group: Group;
  wings: Group[];
}

/** The dragon from boxes: body, neck, head with violet eyes, tail, two wings hinged at the body. */
export function dragonModel(root: Group): DragonModel {
  // Unlit materials, so the colours are the picture: dark, yet lighter than the night sky behind.
  const body = new MeshBasicMaterial({ color: '#34283f' }),
    wingSkin = new MeshBasicMaterial({ color: '#4a3a5e' }),
    eye = new MeshBasicMaterial({ color: '#d65cff' });
  const group = new Group();
  const box = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    material = body,
    parent: Group = group,
  ) => {
    const mesh = new Mesh(new BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  // Facing +z.
  box(3, 2.4, 8, 0, 0, 0);
  box(1.4, 1.4, 4, 0, 0.8, 5.5);
  box(2, 1.6, 3, 0, 1, 8.8);
  for (const x of [-0.55, 0.55]) box(0.35, 0.25, 0.1, x, 1.4, 10.32, eye);
  for (let i = 0; i < 6; i++)
    box(1.4 - i * 0.18, 1.2 - i * 0.14, 2.4, 0, -0.1 - i * 0.1, -5.2 - i * 2.3);
  const wings = [-1, 1].map((side) => {
    const hinge = new Group();
    hinge.position.set(side * 1.5, 0.9, 1);
    group.add(hinge);
    box(10, 0.25, 5, side * 5, 0, -1, wingSkin, hinge);
    box(10, 0.5, 0.5, side * 5, 0.2, 1.4, body, hinge);
    return hinge;
  });
  group.scale.setScalar(0.65);
  root.add(group);
  return { group, wings };
}

/**
 * The dragon circles; now and then it sweeps low over the chest and the chest feels it. The loop is an
 * ellipse in front of the camera (a circle round the chest would pass behind it); a sweep brings it
 * above the chest, near enough to loom, far enough to stay whole in the frame.
 */
export function dragonFlight(
  { group, wings }: DragonModel,
  {
    floor,
    first = 20,
    every = [35, 25],
    swoop = [0, 7, -16],
  }: {
    readonly floor: number;
    readonly first?: number;
    /** [least, extra] seconds between sweeps. */
    readonly every?: readonly [number, number];
    /** Where a sweep reaches, from the floor (x, height above it, z). */
    readonly swoop?: readonly [number, number, number];
  },
): Living<ChestHandles> {
  const ORBIT = { x: 36, z: 28, centre: -34, height: floor + 10 },
    SWOOP = [swoop[0], floor + swoop[1], swoop[2]] as const;
  let angle = 0,
    next = first,
    sweep = -1,
    struck = false;
  const SWEEP = 6;
  return {
    update(context, dt) {
      if (sweep < 0 && (next -= dt) <= 0) {
        sweep = 0;
        struck = false;
        next = every[0] + context.rand() * every[1];
      }
      // low: 0 on the loop, 1 at the bottom of a sweep.
      const low = sweep < 0 ? 0 : Math.sin(Math.min(1, sweep / SWEEP) * Math.PI);
      if (sweep >= 0 && (sweep += dt) > SWEEP) sweep = -1;
      angle += dt * 0.12 * (1 + low * 1.5);
      const before = group.position.clone(),
        mix = (a: number, b: number) => a + (b - a) * low;
      const x = mix(Math.sin(angle) * ORBIT.x, SWOOP[0]),
        z = mix(ORBIT.centre - Math.cos(angle) * ORBIT.z, SWOOP[2]);
      group.position.set(x, mix(ORBIT.height, SWOOP[1]) + Math.sin(context.time * 1.3) * 0.8, z);
      // Nose along the flight, banked into the turn.
      const moved = group.position.clone().sub(before);
      if (moved.x || moved.z)
        group.rotation.set(0, Math.atan2(moved.x, moved.z), -0.35 * (1 - low));
      const flap = Math.sin(context.time * (3 + low * 3)) * 0.55;
      wings[0]!.rotation.z = flap;
      wings[1]!.rotation.z = -flap;
      if (low > 0.95 && !struck) {
        struck = true;
        const side = x < 0 ? -1 : 1;
        context.host?.tremor(0.6, 1.2);
        context.host?.light('#c06cff', 0.75, 1);
        context.gust(0.9, side);
        context.flash('#6a2cff', 0.35);
      }
    },
  };
}
