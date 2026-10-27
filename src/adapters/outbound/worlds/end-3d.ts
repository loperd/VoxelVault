import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  IcosahedronGeometry,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';
import {
  BlockRegistry,
  BlockWorld,
  blockAtlas,
  computeLight,
  meshWorld,
  worldMeshes,
  type Living,
  type Stage,
  type StageBuilder,
} from '../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../application/ports/chest-handles.ts';
import { dragonFlight, dragonModel } from './dragon-actor.ts';

type EndActor = Living<ChestHandles>;

/** The End: broken end-stone shelves frame a clear floating chest, with obsidian spires,
 * chorus growth, drifting motes and distant Endermen. Geometry is generated locally. */
const BLOCKS = new BlockRegistry([
  { name: 'end_stone', textures: { all: 'end_stone' } },
  { name: 'obsidian', textures: { all: 'obsidian' } },
  { name: 'chorus', textures: { all: 'chorus' } },
  { name: 'bloom', textures: { all: 'chorus_flower' }, light: 12 },
]);
const B = {
  Stone: BLOCKS.id('end_stone'),
  Obsidian: BLOCKS.id('obsidian'),
  Chorus: BLOCKS.id('chorus'),
  Bloom: BLOCKS.id('bloom'),
};
const SX = 128,
  SY = 56,
  SZ = 128,
  OX = -64,
  OZ = -92,
  FLOOR = 14;
/** Where the chest lands: the flat top of a small island in the middle; the camera 9 blocks off. */
const CHEST = [0.5, FLOOR + 1, 0.5] as const;
const EYE = [CHEST[0], CHEST[1] + 2.45, CHEST[2] + 9] as const;

function build(seed: number): Stage<ChestHandles> {
  let state = seed * 104729 + 97;
  const rand = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
  const grid = new BlockWorld(SX, SY, SZ, [OX, 0, OZ]);
  const heightAt = (x: number, z: number, cx: number, cz: number, rx: number, rz: number) => {
    const d = Math.hypot((x - cx) / rx, (z - cz) / rz);
    if (d >= 1) return -1;
    return Math.max(2, Math.round(9 + (1 - d) * 8 + (fbm(x / 9, z / 9, seed) - 0.5) * 4));
  };
  // A broken ring of islands surrounds the camera, keeping the chest silhouette unobstructed.
  const islands = [
    [-40, -42, 24, 19],
    [40, -52, 25, 20],
    [-45, 12, 22, 17],
    [44, 7, 23, 18],
    [-5, -88, 43, 21],
    [2, 32, 37, 19],
  ] as const;
  for (let gx = 0; gx < SX; gx++)
    for (let gz = 0; gz < SZ; gz++) {
      const x = gx + OX,
        z = gz + OZ;
      // Leave a broad aperture around the chest and the center line of sight.
      if (Math.abs(x) < 17 && z > -37 && z < 14) {
        // The chest's own island: a small pedestal over the void, ending well before the camera.
        const d = Math.hypot(x / 4, z / 3.5);
        if (d >= 1) continue;
        const top = d < 0.7 ? FLOOR : FLOOR - 1;
        for (let y = Math.floor(top - 2 - Math.pow(1 - d, 0.6) * 10); y <= top; y++)
          grid.set(gx, y, gz, B.Stone);
        continue;
      }
      let h = -1,
        islandEdge = 1;
      for (const [cx, cz, rx, rz] of islands) {
        const candidate = heightAt(x, z, cx, cz, rx, rz);
        if (candidate > h) {
          h = candidate;
          islandEdge = Math.hypot((x - cx) / rx, (z - cz) / rz);
        }
      }
      if (h < 0) continue;
      // Jagged hanging undersides keep each island floating instead of reading as a tall wall.
      const underside = Math.max(0, Math.floor(h - 5 - Math.pow(1 - islandEdge, 0.55) * 13));
      for (let y = underside; y <= h; y++) {
        grid.set(gx, y, gz, B.Stone);
      }
    }
  const pillars: { x: number; z: number; h: number; crown?: number }[] = [
    [-47, -43, 31],
    [43, -53, 38],
    [-48, 9, 25],
    [48, 4, 33],
    [-5, -99, 42],
    [12, 29, 24],
  ].map(([x, z, h]) => ({ x: x!, z: z!, h: h! }));
  for (const p of pillars) {
    const gx = p.x - OX,
      gz = p.z - OZ;
    const [cx, cz, rx, rz] = nearestIsland(p.x, p.z, islands);
    const base = Math.max(2, heightAt(p.x, p.z, cx, cz, rx, rz));
    const radius = p.h > 35 ? 2 : 1;
    for (let y = base; y < base + p.h; y++)
      for (let dx = -radius; dx <= radius; dx++)
        for (let dz = -radius; dz <= radius; dz++) {
          if (dx * dx + dz * dz <= radius * radius + 1) grid.set(gx + dx, y, gz + dz, B.Obsidian);
        }
    p.crown = base + p.h + 1;
    // Crystal crown on each spire.
    grid.set(gx, base + p.h, gz, B.Bloom);
    for (const [dx, dz] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const)
      grid.set(gx + dx, base + p.h - 1, gz + dz, B.Bloom);
  }
  // Chorus plants are sparse silhouettes on the outer islands.
  for (let i = 0; i < 54; i++) {
    const x = Math.floor(rand() * 104 - 52),
      z = Math.floor(rand() * 112 - 78);
    if (Math.abs(x) < 22 && z > -45 && z < 16) continue;
    const island = islands.find(
      ([cx, cz, rx, rz]) => Math.hypot((x - cx) / rx, (z - cz) / rz) < 0.82,
    );
    if (!island) continue;
    const h = heightAt(x, z, island[0], island[1], island[2], island[3]),
      gx = x - OX,
      gz = z - OZ;
    if (h < 1 || grid.get(gx, h, gz) !== B.Stone || rand() < 0.25) continue;
    const stalk = 3 + Math.floor(rand() * 4);
    for (let y = 1; y <= stalk; y++) grid.set(gx, h + y, gz, B.Chorus);
    for (const [dx, dz] of [
      [-2, 0],
      [2, 0],
      [0, -2],
      [0, 2],
    ] as const) {
      if (rand() > 0.55) {
        for (let j = 1; j <= 2; j++)
          grid.set(gx + (dx * j) / 2, h + stalk - j, gz + (dz * j) / 2, B.Chorus);
        grid.set(gx + dx, h + stalk - 2, gz + dz, B.Bloom);
      }
    }
    grid.set(gx, h + stalk + 1, gz, B.Bloom);
  }
  computeLight(grid, BLOCKS);
  const { texture, uv } = blockAtlas();
  const root = new Group();
  root.add(
    ...worldMeshes(
      meshWorld(grid, BLOCKS, {
        uv,
        sky: [0.58, 0.55, 0.7],
        glow: [0.72, 0.5, 1],
        minimum: 0.08,
        sun: {
          direction: [-0.45, 0.72, 0.52],
          color: [0.72, 0.65, 0.85],
          strength: 0.25,
          reach: 24,
        },
      }),
      texture,
    ),
  );
  const dragon = dragonModel(root);
  const living: EndActor[] = [
    crystalBeams(root, pillars),
    endermen(root),
    driftingMotes(root, rand),
    visitors(root),
    crystalBlasts(root, pillars),
    // The dragon is low and often here: the first sweep comes within seconds, then every 15–25.
    dragonFlight(dragon, { floor: FLOOR, first: 9, every: [15, 10], swoop: [0, 5.5, -11] }),
  ];
  return {
    root,
    living,
    calm: 0.025,
    sky: { top: '#080b18', horizon: '#28213b', bottom: '#111322' },
    fog: { color: '#211d35', near: 45, far: 190 },
    camera: {
      position: EYE,
      target: [CHEST[0], CHEST[1] + 0.75, CHEST[2]],
      fov: 50,
      drift: 0.1,
      focus: [0.5, 0.44],
    },
    anchor: CHEST,
    light: { sky: '#d8cdf0', ground: '#3a3350', key: '#efe6ff', from: [-0.4, 0.7, 1] },
    ground: { blocks: { world: grid, registry: BLOCKS, around: [CHEST[0], CHEST[2]], radius: 6 } },
  };
}

/** Smooth, seeded terrain variation; independent of the removed voxel renderer. */
export function fbm(x: number, z: number, seed: number): number {
  const hash = (a: number, b: number, octave: number) => {
    const value = Math.sin(a * 127.1 + b * 311.7 + seed * 74.7 + octave * 19.3) * 43758.5453;
    return value - Math.floor(value);
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  let sum = 0,
    weight = 1,
    total = 0;
  for (let octave = 0; octave < 4; octave++) {
    const ix = Math.floor(x),
      iz = Math.floor(z),
      fx = smooth(x - ix),
      fz = smooth(z - iz);
    const top = lerp(hash(ix, iz, octave), hash(ix + 1, iz, octave), fx);
    const bottom = lerp(hash(ix, iz + 1, octave), hash(ix + 1, iz + 1, octave), fx);
    sum += lerp(top, bottom, fz) * weight;
    total += weight;
    x *= 2;
    z *= 2;
    weight *= 0.5;
  }
  return sum / total;
}

function nearestIsland(
  x: number,
  z: number,
  islands: readonly (readonly [number, number, number, number])[],
): [number, number, number, number] {
  return [...islands].sort(
    (a, b) =>
      Math.hypot((x - a[0]) / a[2], (z - a[1]) / a[3]) -
      Math.hypot((x - b[0]) / b[2], (z - b[1]) / b[3]),
  )[0]! as [number, number, number, number];
}

function crystalBeams(
  root: Group,
  pillars: readonly { x: number; z: number; h: number }[],
): EndActor {
  const material = new LineBasicMaterial({
    color: '#bf8cff',
    transparent: true,
    opacity: 0.08,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const beams: Line[] = [];
  for (let i = 0; i < pillars.length; i++)
    for (let j = i + 1; j < pillars.length; j++) {
      const a = pillars[i]!,
        b = pillars[j]!;
      if (Math.hypot(a.x - b.x, a.z - b.z) > 100) continue;
      const geometry = new BufferGeometry().setFromPoints([
        new Vector3(a.x, a.h + 10, a.z),
        new Vector3(b.x, b.h + 10, b.z),
      ]);
      const line = new Line(geometry, material);
      root.add(line);
      beams.push(line);
    }
  return {
    update(world) {
      material.opacity = 0.035 + (Math.sin(world.time * 0.45) + 1) * 0.025;
    },
  };
}

const ENDERMAN = {
  body: new MeshBasicMaterial({ color: '#171522' }),
  eye: new MeshBasicMaterial({ color: '#dc70ff' }),
};
function endermanModel(): Group {
  const group = new Group(),
    { body: mat, eye } = ENDERMAN;
  const body = new Mesh(new BoxGeometry(0.65, 1.7, 0.42), mat);
  body.position.y = 1.5;
  group.add(body);
  for (const x of [-0.15, 0.15]) {
    const e = new Mesh(new BoxGeometry(0.1, 0.07, 0.035), eye);
    e.position.set(x, 1.82, 0.22);
    group.add(e);
  }
  for (const x of [-0.2, 0.2]) {
    const leg = new Mesh(new BoxGeometry(0.16, 1.05, 0.16), mat);
    leg.position.set(x, 0.52, 0);
    group.add(leg);
  }
  return group;
}

function endermen(root: Group): EndActor {
  const actors: { group: Group; x: number; y: number; z: number; phase: number; speed: number }[] =
    [];
  for (let i = 0; i < 4; i++) {
    const group = endermanModel();
    const x = i % 2 ? 43 : -43,
      z = -58 + i * 17;
    const y = i % 2 ? 12 : 10;
    group.position.set(x, y, z);
    root.add(group);
    actors.push({ group, x, y, z, phase: i * 1.8, speed: i % 2 ? -0.45 : 0.38 });
  }
  return {
    update(world, dt) {
      for (const a of actors) {
        a.phase += dt * a.speed;
        a.group.position.x = a.x + Math.sin(a.phase) * 4;
        a.group.position.z = a.z + Math.cos(a.phase * 0.7) * 3;
        a.group.rotation.y = Math.sin(a.phase) * 0.4;
        a.group.position.y = a.y + Math.sin(world.time * 1.2 + a.phase) * 0.12;
        if (Math.sin(world.time * 0.13 + a.phase) > 0.997) {
          a.group.visible = false;
        } else a.group.visible = true;
      }
    },
  };
}

/** A burst of violet specks from a point, rising and fading over about a second. */
function puffs(
  root: Group,
  count: number,
  color: string,
  size: number,
  spread: number,
  rise: number,
) {
  const positions = new Float32Array(count * 3),
    velocity = Array.from({ length: count }, () => new Vector3()),
    geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const material = new PointsMaterial({
    color: new Color(color),
    size,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  root.add(points);
  let age = 9;
  return {
    burst(at: readonly [number, number, number], rand: () => number) {
      age = 0;
      for (let i = 0; i < count; i++) {
        positions.set(at, i * 3);
        velocity[i]!.set((rand() - 0.5) * spread, rand() * rise, (rand() - 0.5) * spread);
      }
    },
    update(dt: number) {
      if (age > 1.2) {
        material.opacity = 0;
        return;
      }
      age += dt;
      material.opacity = Math.max(0, 1 - age / 1.2);
      for (let i = 0; i < count; i++) {
        const v = velocity[i]!,
          k = i * 3;
        positions[k] = positions[k]! + v.x * dt;
        positions[k + 1] = positions[k + 1]! + v.y * dt;
        positions[k + 2] = positions[k + 2]! + v.z * dt;
        v.y -= dt * 1.5;
      }
      geometry.attributes.position!.needsUpdate = true;
    },
  };
}

/** Endermen teleport onto the chest's island one at a time: a puff, a long stare at the chest, a shudder, a puff, gone. */
function visitors(root: Group): EndActor {
  const rim = [
      [-3.3, 1],
      [3.7, -0.6],
      [0.6, -2.7],
      [-2.2, -2.2],
    ] as const,
    group = endermanModel(),
    smoke = puffs(root, 36, '#c27bff', 0.3, 4, 3);
  group.visible = false;
  root.add(group);
  // The island's surface: its middle is a block higher than its rim.
  const surface = (x: number, z: number) => (Math.hypot(x / 4, z / 3.5) < 0.7 ? FLOOR + 1 : FLOOR);
  let wait = 4,
    stay = 0,
    at = 0;
  return {
    update(context, dt) {
      smoke.update(dt);
      if (group.visible) {
        stay -= dt;
        // Angry: it trembles faster as it gets ready to leave.
        group.position.x =
          rim[at]![0] + 0.5 + Math.sin(context.time * 55) * Math.max(0, 0.6 - stay) * 0.05;
        if (stay <= 0) {
          smoke.burst([group.position.x, group.position.y + 1.4, group.position.z], context.rand);
          group.visible = false;
          wait = 5 + context.rand() * 6;
        }
        return;
      }
      if ((wait -= dt) > 0) return;
      const next = (at + 1 + Math.floor(context.rand() * (rim.length - 1))) % rim.length,
        [x, z] = rim[next]!;
      at = next;
      stay = 4 + context.rand() * 2;
      group.position.set(x + 0.5, surface(x, z), z + 0.5);
      group.rotation.y = Math.atan2(CHEST[0] - group.position.x, CHEST[2] - group.position.z);
      group.visible = true;
      smoke.burst([group.position.x, group.position.y + 1.4, group.position.z], context.rand);
      context.host?.light('#cc7bff', 0.5, 0.5);
    },
  };
}

/** An end crystal on a spire goes off now and then: a ball of fire, debris, a flash and a tremor that reaches the chest. */
function crystalBlasts(
  root: Group,
  pillars: readonly { x: number; z: number; crown?: number }[],
): EndActor {
  const fire = new MeshBasicMaterial({
    color: '#ffb4f0',
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const ball = new Mesh(new IcosahedronGeometry(1, 1), fire);
  ball.visible = false;
  root.add(ball);
  const debris = puffs(root, 48, '#ff8fe0', 0.9, 18, 14);
  let wait = 6,
    age = -1;
  return {
    update(context, dt) {
      debris.update(dt);
      if (age >= 0) {
        age += dt;
        ball.scale.setScalar(1 + age * 22);
        fire.opacity = Math.max(0, 0.9 - age / 0.9);
        if (age > 0.9) {
          age = -1;
          ball.visible = false;
          wait = 7 + context.rand() * 7;
        }
        return;
      }
      if ((wait -= dt) > 0) return;
      const p = pillars[Math.floor(context.rand() * pillars.length)]!,
        y = (p.crown ?? FLOOR + 20) + 1.5;
      ball.position.set(p.x + 0.5, y, p.z + 0.5);
      ball.scale.setScalar(1);
      ball.visible = true;
      age = 0;
      debris.burst([p.x + 0.5, y, p.z + 0.5], context.rand);
      context.flash('#ff9cf0', 0.3);
      context.host?.tremor(0.4, 0.7);
      context.host?.light('#ff8fe0', 0.8, 0.5);
    },
  };
}

export function driftingMotes(root: Group, rand: () => number): EndActor {
  const count = 100,
    positions = new Float32Array(count * 3),
    geometry = new BufferGeometry();
  for (let i = 0; i < count; i++)
    positions.set([(rand() - 0.5) * 150, 5 + rand() * 42, -rand() * 155], i * 3);
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const points = new Points(
    geometry,
    new PointsMaterial({
      color: new Color('#aa8bd8'),
      size: 0.42,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  );
  root.add(points);
  return {
    update(world, dt) {
      for (let i = 0; i < count; i++) {
        const k = i * 3;
        positions[k] = positions[k]! + Math.sin(world.time * 0.4 + i) * dt * 0.25;
        positions[k + 1] = positions[k + 1]! + Math.sin(world.time * 0.7 + i * 2) * dt * 0.12;
      }
      geometry.attributes.position!.needsUpdate = true;
    },
  };
}

export const END_3D: StageBuilder<ChestHandles> = { id: 'end-3d', build };
