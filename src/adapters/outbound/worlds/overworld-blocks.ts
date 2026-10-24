import {
  AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, Group, InstancedMesh, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, Points, PointsMaterial,
} from 'three';
import {
  BlockRegistry, BlockWorld, blockAtlas, computeLight, meshWorld, raw, worldMeshes, type Living, type Stage, type StageBuilder,
} from '../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../application/ports/chest-handles.ts';
import { happenings, mobMaterial, shadedBox } from './overworld-life.ts';

/**
 * The Overworld at dusk ("Дороги Верхнего мира"), built by the rules of the game: every block one
 * cell, textured 16×16, lit by sky and torch light levels with smooth lighting and ambient
 * occlusion. A meadow with a gravel road runs up to the chest between oak and birch hills; a lake
 * on one side, snowy ranges far behind. Alive: slab clouds drift; a storm behind the ranges throws
 * lightning — its flash and thunder reach the chest through its handles.
 */
const BLOCKS = new BlockRegistry([
  { name: 'grass', textures: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' } },
  { name: 'dirt', textures: { all: 'dirt' } },
  { name: 'stone', textures: { all: 'stone' } },
  { name: 'gravel', textures: { all: 'gravel' } },
  { name: 'sand', textures: { all: 'sand' } },
  { name: 'snow', textures: { all: 'snow' } },
  { name: 'oak_log', textures: { side: 'oak_log', top: 'oak_log_top' } },
  { name: 'oak_leaves', textures: { all: 'oak_leaves' }, transparent: true, cutout: true },
  { name: 'birch_log', textures: { side: 'birch_log', top: 'birch_log_top' } },
  { name: 'birch_leaves', textures: { all: 'birch_leaves' }, transparent: true, cutout: true },
  { name: 'pumpkin', textures: { side: 'pumpkin_side', top: 'pumpkin_top' } },
  { name: 'torch', model: 'torch', textures: { all: 'torch' }, light: 14 },
  { name: 'poppy', model: 'cross', textures: { all: 'poppy' } },
  { name: 'dandelion', model: 'cross', textures: { all: 'dandelion' } },
  { name: 'tall_grass', model: 'cross', textures: { all: 'tall_grass' } },
  { name: 'water', model: 'liquid', textures: { all: 'water' } },
]);
const id = (name: string) => BLOCKS.id(name);

const SX = 112, SY = 40, SZ = 150, OX = -56, OZ = -110, GROUND = 10;
/**
 * Where the chest lands: on the grass by the road (it is a block and a half wide). The camera
 * stands 9 blocks off, a little above eye height, looking at it: the chest stands above the page's
 * label with the meadow, the hills and the sky behind it. The camera moves in when it opens.
 */
const CHEST = [-1.5, GROUND + 1, 6.5] as const;
const EYE = [CHEST[0], CHEST[1] + 2.45, CHEST[2] + 9] as const;
/** The sky light at dusk: warm on the lit side of the world, as the game tints it at sunset. */
const DUSK: [number, number, number] = [1, .78, .64];
/** Where the square sun hangs; the sky, the atmosphere and the baked sun all take its bearing. */
export const SUN_DISC = [-520, 78, -364] as const;
/** The low evening sun (from where its square hangs, a little higher so shadows stay readable). */
export const SUN = { direction: [-0.72, 0.47, -0.51], color: [1, .8, .58], strength: .42, reach: 48 } as const;

function noise(x: number, z: number, seed: number): number {
  const s = (v: number) => { const h = Math.sin(v) * 43758.5453; return h - Math.floor(h); };
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi, k = (t: number) => t * t * (3 - 2 * t);
  const h = (a: number, b: number) => s(a * 127.1 + b * 311.7 + seed * 74.7);
  const top = h(xi, zi) + (h(xi + 1, zi) - h(xi, zi)) * k(xf), bottom = h(xi, zi + 1) + (h(xi + 1, zi + 1) - h(xi, zi + 1)) * k(xf);
  return top + (bottom - top) * k(zf);
}
function fbm(x: number, z: number, seed: number): number {
  let sum = 0, amp = 1, total = 0, f = 1;
  for (let i = 0; i < 4; i++) { sum += noise(x * f, z * f, seed + i * 13) * amp; total += amp; amp *= .5; f *= 2; }
  return sum / total;
}

const roadAt = (z: number) => Math.round(Math.sin(z * .06) * 4);
const lake = (x: number, z: number) => Math.hypot((x - 30) / 12, (z + 34) / 8) < 1;

function heightAt(x: number, z: number, seed: number): number {
  const wild = GROUND - 1 + fbm((x + 400) / 30, (z + 400) / 30, seed) * 10 + Math.max(0, Math.abs(x) - 16) * .1;
  // Flat where the chest stands, rising softly away from it.
  const edge = Math.max(0, Math.max(Math.abs(x) - 12, -z - 30, z - 24)) / 14, weight = Math.min(1, edge * edge);
  return Math.round(GROUND + (wild - GROUND) * weight);
}

function oak(world: BlockWorld, x: number, y: number, z: number, rand: () => number): void {
  const birch = rand() < .3, log = id(birch ? 'birch_log' : 'oak_log'), leaves = id(birch ? 'birch_leaves' : 'oak_leaves');
  const h = 4 + Math.floor(rand() * 3);
  // The game's small oak: two 5×5 layers, then 3×3 caps; the outer corners are random.
  for (let dy = h - 2; dy <= h + 1; dy++) {
    const r = dy >= h ? 1 : 2;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.abs(dx) === r && Math.abs(dz) === r && (dy === h + 1 || rand() < .5)) continue;
      if (!world.get(x + dx, y + dy, z + dz)) world.set(x + dx, y + dy, z + dz, leaves);
    }
  }
  for (let dy = 0; dy < h; dy++) world.set(x, y + dy, z, log);
}

function build(seed: number, events: Parameters<typeof happenings>[2] = {}): Stage<ChestHandles> {
  let state = seed * 7919 + 13;
  const rand = () => { state = (state * 16807) % 2147483647; return state / 2147483647; };
  const world = new BlockWorld(SX, SY, SZ, [OX, 0, OZ]);
  const heights: number[] = [];
  for (let gz = 0; gz < SZ; gz++) for (let gx = 0; gx < SX; gx++) {
    const x = gx + OX, z = gz + OZ;
    let h = heightAt(x, z, seed);
    if (lake(x, z)) h = GROUND - 3;
    heights[gx + gz * SX] = h;
    for (let y = 0; y <= h; y++) {
      const depth = h - y;
      let block = depth === 0 ? 'grass' : depth < 3 ? 'dirt' : 'stone';
      if (h > 24 && depth === 0) block = 'snow';
      if (Math.hypot((x - 30) / 14, (z + 34) / 10) < 1 && depth === 0) block = 'sand';
      world.set(gx, y, gz, id(block));
    }
    if (lake(x, z)) for (let y = h + 1; y <= GROUND - 1; y++) world.set(gx, y, gz, id('water'));
  }
  const top = (x: number, z: number) => heights[(x - OX) + (z - OZ) * SX] ?? GROUND;
  // The gravel road up to the chest.
  for (let z = -80; z < 30; z++) for (let dx = -1; dx <= 1; dx++) {
    const x = roadAt(z) + dx;
    if (world.inside(x - OX, 0, z - OZ)) world.set(x - OX, top(x, z), z - OZ, id('gravel'));
  }
  // Trees, flowers and grass — off the meadow, the road and the lake.
  for (let i = 0; i < 2400; i++) {
    const x = Math.floor(rand() * SX) + OX, z = Math.floor(rand() * SZ) + OZ, h = top(x, z);
    if (Math.abs(x - roadAt(z)) < 3 || lake(x, z) || world.get(x - OX, h, z - OZ) !== id('grass') || world.get(x - OX, h + 1, z - OZ)) continue;
    // Nothing grows right at the camera's feet: a grass tuft there would fill the screen.
    if (Math.hypot(x - EYE[0], z - EYE[2]) < 4.5 || Math.hypot(x - CHEST[0], z - CHEST[2]) < 2.2) continue;
    const meadow = Math.abs(x) < 20 && z > -40;
    const roll = rand();
    if (!meadow && roll < .1) oak(world, x - OX, h + 1, z - OZ, rand);
    else if (roll < .45) world.set(x - OX, h + 1, z - OZ, id('tall_grass'));
    else if (roll < .52) world.set(x - OX, h + 1, z - OZ, id(rand() < .5 ? 'poppy' : 'dandelion'));
    else if (!meadow && roll < .53) world.set(x - OX, h + 1, z - OZ, id('pumpkin'));
  }
  // Torches on short log posts along the road.
  for (const [dx, z] of [[-3, -6], [3, -18], [-3, -30], [3, -44]] as const) {
    const x = roadAt(z) + dx, h = top(x, z);
    world.set(x - OX, h + 1, z - OZ, id('oak_log')); world.set(x - OX, h + 2, z - OZ, id('torch'));
  }
  computeLight(world, BLOCKS);
  const { texture, uv } = blockAtlas();
  const root = new Group();
  root.add(...worldMeshes(meshWorld(world, BLOCKS, { uv, sky: DUSK, minimum: .06, sun: SUN }), texture));
  root.add(farRanges(seed, uv, texture));
  // The square sun of the game, low and warm.
  const sun = new Mesh(new PlaneGeometry(60, 60), new MeshBasicMaterial({ color: raw('#ffe7a6'), fog: false }));
  sun.position.set(...SUN_DISC); sun.lookAt(0, 20, 0);
  root.add(sun);
  return {
    root, living: [clouds(root, rand), storm(root), sheep(root, rand), fireflies(root, rand), leaves(root, rand),
      happenings(root, { ground: GROUND + 1, chest: CHEST, road: roadAt, tint: DUSK }, events)], calm: .1,
    sun: { direction: SUN_DISC, color: '#ffb36e', scatter: .85 },
    sky: { top: '#2a3a78', horizon: '#f2a46e', bottom: '#3a3050' },
    fog: { color: '#d99a7e', near: 70, far: 330 },
    camera: { position: EYE, target: [CHEST[0], CHEST[1] + .75, CHEST[2]], fov: 50, drift: .12, focus: [.5, .44] },
    // The chest lands here, on the world's own blocks (they are its physics ground), seen by this camera.
    anchor: CHEST, light: { sky: '#ffffff', ground: '#435846', key: '#ffffff', from: [-.5, .6, 1] },
    ground: { blocks: { world, registry: BLOCKS, around: [CHEST[0], CHEST[2]], radius: 12 } },
  };
}

/** The far ranges: a second, coarse block world (4 units a block), lit by the same rules. */
function farRanges(seed: number, uv: (tile: string) => readonly [number, number, number, number], texture: ReturnType<typeof blockAtlas>['texture']): Group {
  const gx = 130, gy = 28, gz = 26, world = new BlockWorld(gx, gy, gz, [-gx / 2, 0, -gz]);
  for (let x = 0; x < gx; x++) for (let z = 0; z < gz; z++) {
    const peak = Math.min(gy - 1, Math.round(Math.pow(fbm(x / 10 + 50, z / 8 + 50, seed + 21), 1.5) * gy * 1.35 * Math.min(1, z / 7 + .25)));
    for (let y = 0; y <= peak; y++) world.set(x, y, z, id(y > 13 && peak - y < 2 ? 'snow' : peak - y === 0 ? 'grass' : 'stone'));
  }
  computeLight(world, BLOCKS);
  const group = new Group();
  group.add(...worldMeshes(meshWorld(world, BLOCKS, { uv, sky: DUSK }), texture));
  group.scale.setScalar(4);
  group.position.set(0, GROUND - 24, -200);
  return group;
}

/** A cloud block at sunset: lit from below and the side by the low sun, so pink, never grey. */
function cloudBox(): BoxGeometry {
  const box = new BoxGeometry(1, 1, 1), colors: number[] = [];
  // +x, -x, +y, -y, +z, -z: the sunward side (-x, -z) warmest, the underside rosy.
  for (const hex of ['#f4c9c4', '#ffe0c8', '#fff0e6', '#eab3b8', '#f1c3c3', '#ffdcc6']) {
    const c = raw(hex);
    for (let v = 0; v < 4; v++) colors.push(c.r, c.g, c.b);
  }
  box.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  return box;
}

/** The game's clouds: flat white slabs at one height, drifting on. */
function clouds(root: Group, rand: () => number): Living<ChestHandles> {
  // Fancy clouds: 4 blocks thick, shaded like blocks — lit tops, darker undersides — high and far.
  const count = 22, mesh = new InstancedMesh(cloudBox(), new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: .8, fog: false }), count);
  const bank = Array.from({ length: count }, () => ({ x: (rand() - .5) * 600, z: -140 - rand() * 380, w: 24 + Math.floor(rand() * 5) * 12, d: 16 + Math.floor(rand() * 4) * 12 }));
  const dummy = new Object3D();
  root.add(mesh);
  return {
    update(context, dt) {
      bank.forEach((cloud, i) => {
        cloud.x += (1.5 + context.wind * 6) * dt;
        if (cloud.x > 300) cloud.x = -300; if (cloud.x < -300) cloud.x = 300;
        dummy.position.set(cloud.x, 108, cloud.z); dummy.scale.set(cloud.w, 4, cloud.d); dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

/** Lightning behind the ranges: the sky lights up and the chest with it; thunder follows. */
function storm(root: Group): Living<ChestHandles> {
  const geometry = new BufferGeometry(), material = new LineBasicMaterial({ color: raw('#f2f5ff'), transparent: true, opacity: 0, fog: false });
  root.add(new Line(geometry, material));
  let next = 22, shown = 0, thunder = -1;
  return {
    update(context, dt) {
      shown = Math.max(0, shown - dt); material.opacity = shown > 0 ? Math.min(1, shown * 6) : 0;
      if (thunder > 0 && (thunder -= dt) <= 0) context.host?.tremor(.35, .9);
      if ((next -= dt) > 0) return;
      next = 30 + context.rand() * 30;
      const points: number[] = []; let x = (context.rand() - .5) * 260, y = 120;
      const z = -300 - context.rand() * 80;
      while (y > 20) { points.push(x, y, z); x += (context.rand() - .5) * 14; y -= 6 + context.rand() * 8; }
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
      shown = .25; context.flash('#d9e2ff', 1); context.host?.light('#dce6ff', .9, .35); thunder = 1 + context.rand() * 1.2;
    },
  };
}

/** Sheep, sized by the game's model (1/16 a pixel): they wander the meadow, stop, graze. */
function sheep(root: Group, rand: () => number): Living<ChestHandles> {
  const px = 1 / 16, material = mobMaterial();
  const wool = shadedBox(10 * px, 9 * px, 15 * px, '#e9e4dc', DUSK), headWool = shadedBox(7 * px, 7 * px, 7 * px, '#e9e4dc', DUSK);
  const face = shadedBox(6 * px, 6 * px, 2 * px, '#c9a991', DUSK), leg = shadedBox(4 * px, 12 * px, 4 * px, '#c9a991', DUSK);
  leg.translate(0, -6 * px, 0);
  const flock = Array.from({ length: 4 }, (_, i) => {
    const body = new Group(), head = new Group(), legs: Mesh[] = [];
    body.add(new Mesh(wool, material).translateY(16 * px));
    head.add(new Mesh(headWool, material), new Mesh(face, material).translateZ(4 * px).translateY(-.5 * px));
    head.position.set(0, 19 * px, 9 * px); body.add(head);
    for (const [lx, lz] of [[-3, -5], [3, -5], [-3, 5], [3, 5]] as const) { const m = new Mesh(leg, material); m.position.set(lx * px, 12 * px, lz * px); legs.push(m); body.add(m); }
    const x = (i % 2 ? 1 : -1) * (4 + rand() * 7), z = 1 - rand() * 16;
    body.position.set(x, GROUND + 1, z); body.rotation.y = rand() * Math.PI * 2;
    root.add(body);
    return { body, head, legs, target: { x, z }, rest: rand() * 4, graze: 0, step: rand() * 10 };
  });
  return {
    update(context, dt) {
      for (const one of flock) {
        const { body } = one, dx = one.target.x - body.position.x, dz = one.target.z - body.position.z, far = Math.hypot(dx, dz);
        let walking = false;
        if (one.rest > 0) {
          one.rest -= dt;
          if (one.rest <= 0) {
            // A new spot nearby on its side of the meadow, clear of the chest in the middle.
            const side = Math.sign(body.position.x) || 1, x = Math.abs(body.position.x) + (context.rand() - .5) * 8;
            one.target = { x: side * Math.max(5, Math.min(11, x)), z: Math.max(-16, Math.min(1, body.position.z + (context.rand() - .5) * 10)) };
          }
        } else if (far < .1) {
          one.rest = 2 + context.rand() * 6; one.graze = context.rand() < .6 ? one.rest : 0;
        } else {
          walking = true;
          const turn = Math.atan2(dx, dz) - body.rotation.y, wrapped = Math.atan2(Math.sin(turn), Math.cos(turn));
          body.rotation.y += Math.max(-dt * 3, Math.min(dt * 3, wrapped));
          if (Math.abs(wrapped) < .6) { const speed = Math.min(far, dt * .9); body.position.x += Math.sin(body.rotation.y) * speed; body.position.z += Math.cos(body.rotation.y) * speed; }
        }
        one.graze = Math.max(0, one.graze - dt);
        if (walking) one.step += dt * 7;
        const swing = walking ? Math.sin(one.step) * .55 : 0;
        one.legs.forEach((legMesh, i) => { legMesh.rotation.x = (i === 0 || i === 3 ? swing : -swing); });
        // Head down to the grass while grazing, chewing a little.
        const down = one.graze > 0 ? .9 + Math.sin(context.time * 9) * .08 : Math.sin(context.time * .6 + one.step) * .06;
        one.head.rotation.x += (down - one.head.rotation.x) * Math.min(1, dt * 4);
        one.head.position.y = (19 - one.head.rotation.x * 8) * px;
      }
    },
  };
}

/** Fireflies over the meadow's edges at dusk: slow drifting sparks that blink. */
function fireflies(root: Group, rand: () => number): Living<ChestHandles> {
  const count = 36, positions = new Float32Array(count * 3), colors = new Float32Array(count * 3);
  const flies = Array.from({ length: count }, () => {
    const side = rand() < .5 ? -1 : 1;
    return { x: side * (8 + rand() * 14), y: GROUND + 1.5 + rand() * 3, z: -24 + rand() * 40, phase: rand() * 10, speed: .4 + rand() * .5 };
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const points = new Points(geometry, new PointsMaterial({ size: .26, vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, fog: false }));
  root.add(points);
  return {
    update(context) {
      const t = context.time;
      flies.forEach((fly, i) => {
        const a = t * fly.speed + fly.phase;
        positions[i * 3] = fly.x + Math.sin(a) * 1.6 + Math.sin(a * 2.3) * .4;
        positions[i * 3 + 1] = fly.y + Math.sin(a * 1.7) * .5;
        positions[i * 3 + 2] = fly.z + Math.cos(a * .8) * 1.6;
        const blink = Math.max(0, Math.sin(t * 1.3 + fly.phase * 3)) ** 3;
        colors[i * 3] = .85 * blink; colors[i * 3 + 1] = 1 * blink; colors[i * 3 + 2] = .35 * blink;
      });
      geometry.attributes.position!.needsUpdate = true; geometry.attributes.color!.needsUpdate = true;
    },
  };
}

/** Leaves coming off the oaks on the slopes, drifting down and away with the wind. */
function leaves(root: Group, rand: () => number): Living<ChestHandles> {
  const count = 48, positions = new Float32Array(count * 3);
  const spawn = (leaf: { x: number; y: number; z: number; fall: number; phase: number }, anywhere: boolean) => {
    const side = rand() < .5 ? -1 : 1;
    leaf.x = side * (13 + rand() * 18); leaf.z = -46 + rand() * 56;
    leaf.y = GROUND + (anywhere ? 1 + rand() * 9 : 8 + rand() * 3);
    leaf.fall = .5 + rand() * .5; leaf.phase = rand() * 10;
  };
  const fall = Array.from({ length: count }, () => { const leaf = { x: 0, y: 0, z: 0, fall: 0, phase: 0 }; spawn(leaf, true); return leaf; });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  root.add(new Points(geometry, new PointsMaterial({ size: .2, color: raw('#5f7f2c'), transparent: true, opacity: .9 })));
  return {
    update(context, dt) {
      fall.forEach((leaf, i) => {
        leaf.y -= leaf.fall * dt;
        leaf.x += (context.wind * 2.4 + Math.sin(context.time * 1.8 + leaf.phase) * .6) * dt;
        if (leaf.y < GROUND + 1) spawn(leaf, false);
        positions[i * 3] = leaf.x + Math.sin(context.time * 2.6 + leaf.phase) * .3;
        positions[i * 3 + 1] = leaf.y; positions[i * 3 + 2] = leaf.z;
      });
      geometry.attributes.position!.needsUpdate = true;
    },
  };
}

export const OVERWORLD_BLOCKS: StageBuilder<ChestHandles> = { id: 'overworld-blocks', build: seed => build(seed) };

/** The Overworld with only some happenings, the first one soon (previews). */
export const overworldWith = (events: Parameters<typeof happenings>[2]): StageBuilder<ChestHandles> =>
  ({ id: `overworld-blocks:${(events?.only ?? []).join('+')}`, build: seed => build(seed, events) });
