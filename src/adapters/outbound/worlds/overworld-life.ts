import {
  BoxGeometry, BufferAttribute, BufferGeometry, DataTexture, Group, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, NearestFilter, Points, PointsMaterial, RepeatWrapping, type Object3D,
} from 'three';
import { raw, type Living, type StageContext } from '../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../application/ports/chest-handles.ts';

/**
 * Things that happen in the Overworld now and then, one at a time, in random order: a creeper
 * creeps up under the chest and blows up (the chest shakes and swings), a rabbit hops across, a
 * flock flies over, a villager comes down the road, a star falls. Mobs are built to the game's
 * models, a pixel being 1/16 of a block, and shaded the way the game shades blocks.
 */
export interface Place {
  /** Top of the grass the mobs stand on. */
  readonly ground: number;
  /** Where the chest hangs in the world. */
  readonly chest: readonly [number, number, number];
  /** The road's x at a given z. */
  readonly road: (z: number) => number;
  /** The evening light that tints everything. */
  readonly tint: readonly [number, number, number];
  /** Where the creeper stops, from the chest (x mirrored to its side, z); by default right under it. */
  readonly stand?: readonly [number, number];
}

const PX = 1 / 16;
const TILE = 8;

/** Mottled pixels, one texel to a pixel of a mob's model: a grey that vertex colours tint (the game's mobs are never flat). */
export const MOB_PIXELS = (() => {
  const data = new Uint8Array(TILE * TILE * 4);
  for (let i = 0; i < TILE * TILE; i++) {
    const h = Math.sin(i * 12.9898) * 43758.5453, shade = 200 + Math.floor((h - Math.floor(h)) * 56);
    data.set([shade, shade, shade, 255], i * 4);
  }
  const texture = new DataTexture(data, TILE, TILE);
  texture.wrapS = texture.wrapT = RepeatWrapping; texture.magFilter = texture.minFilter = NearestFilter; texture.needsUpdate = true;
  return texture;
})();
/** The material every mob part shares. */
export const mobMaterial = () => new MeshBasicMaterial({ vertexColors: true, map: MOB_PIXELS });

/** A box shaded like a block (top 1, north/south .8, east/west .6, bottom .5) under the world's light. */
export function shadedBox(w: number, h: number, d: number, hex: string, tint: readonly [number, number, number], light = .86): BoxGeometry {
  const box = new BoxGeometry(w, h, d), base = raw(hex), colors: number[] = [];
  // BoxGeometry faces in order: +x, -x, +y, -y, +z, -z; four vertices each.
  for (const shade of [.6, .6, 1, .5, .8, .8]) for (let v = 0; v < 4; v++) colors.push(base.r * shade * light * tint[0], base.g * shade * light * tint[1], base.b * shade * light * tint[2]);
  box.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  // A tile covers TILE pixels of the model: each face's UVs span its size in pixels.
  const uv = box.getAttribute('uv'), faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]] as const;
  for (const [face, [a, b]] of faces.entries()) for (let v = 0; v < 4; v++) {
    const i = face * 4 + v; uv.setXY(i, uv.getX(i) * a * 16 / TILE, uv.getY(i) * b * 16 / TILE);
  }
  return box;
}

interface Happening { update(context: StageContext<ChestHandles>, dt: number): boolean }
type Start = (root: Group, place: Place, context: StageContext<ChestHandles>) => Happening;

/** `only` narrows what may happen (previews, tests); `first` is how long until the first thing. */
export function happenings(root: Group, place: Place, options: { only?: readonly HappeningKind[]; first?: number } = {}): Living<ChestHandles> {
  const kinds = (options.only ?? Object.keys(KINDS) as HappeningKind[]).map(kind => [KINDS[kind], WEIGHTS[kind]] as const);
  let wait = options.first ?? 3, current: Happening | undefined, last: Start | undefined;
  return {
    update(context, dt) {
      if (current) { if (!current.update(context, dt)) { current = undefined; wait = 8 + context.rand() * 14; } return; }
      if ((wait -= dt) > 0) return;
      // Weighted pick, never the same thing twice in a row.
      const options = kinds.length > 1 ? kinds.filter(([start]) => start !== last) : kinds, total = options.reduce((sum, [, weight]) => sum + weight, 0);
      let roll = context.rand() * total;
      const [start] = options.find(([, weight]) => (roll -= weight) < 0) ?? options[0]!;
      last = start; current = start(root, place, context);
    },
  };
}

/** One part of a mob, sized and placed in pixels, its pivot at the given point. */
function part(group: Object3D, size: readonly [number, number, number], hex: string, place: Place, at: readonly [number, number, number], material: MeshBasicMaterial, offset: readonly [number, number, number] = [0, 0, 0]): Group {
  const pivot = new Group(), mesh = new Mesh(shadedBox(size[0] * PX, size[1] * PX, size[2] * PX, hex, place.tint), material);
  mesh.position.set(offset[0] * PX, offset[1] * PX, offset[2] * PX);
  pivot.add(mesh); pivot.position.set(at[0] * PX, at[1] * PX, at[2] * PX);
  group.add(pivot);
  return pivot;
}

/** Walk a mob towards a point, turning first; returns true once there. */
function walk(body: Group, to: readonly [number, number], speed: number, dt: number): boolean {
  const dx = to[0] - body.position.x, dz = to[1] - body.position.z, far = Math.hypot(dx, dz);
  if (far < .05) return true;
  const turn = Math.atan2(dx, dz) - body.rotation.y, wrapped = Math.atan2(Math.sin(turn), Math.cos(turn));
  body.rotation.y += Math.max(-dt * 4, Math.min(dt * 4, wrapped));
  if (Math.abs(wrapped) < .7) { const step = Math.min(far, speed * dt); body.position.x += Math.sin(body.rotation.y) * step; body.position.z += Math.cos(body.rotation.y) * step; }
  return false;
}

function dispose(group: Object3D): void {
  group.removeFromParent();
  group.traverse(child => { if (child instanceof Mesh || child instanceof Points || child instanceof Line) { child.geometry.dispose(); (child.material as MeshBasicMaterial).dispose(); } });
}

/** Sss… A creeper comes for the chest, swells, flashes and goes off right under it. */
const creeper: Start = (root, place, context) => {
  const side = context.rand() < .5 ? -1 : 1, material = mobMaterial();
  const body = new Group(), green = '#5aa845', dark = '#1d2a1a';
  part(body, [8, 12, 4], green, place, [0, 12, 0], material);
  const head = part(body, [8, 8, 8], green, place, [0, 22, 0], material);
  // The face: eyes and the frown, a hair proud of the head's front.
  for (const [w, h, x, y] of [[2, 2, -2, 1], [2, 2, 2, 1], [2, 3, 0, -1.5], [1, 2, -1.5, -3], [1, 2, 1.5, -3]] as const) part(head, [w, h, .3], dark, place, [x, y, 4.1], material);
  const legs = [[-2, -4], [2, -4], [-2, 4], [2, 4]].map(([x, z]) => part(body, [4, 6, 4], green, place, [x!, 6, z! * .75], material, [0, -3, 0]));
  body.position.set(place.chest[0] + side * 14, place.ground, place.chest[2] - 7);
  root.add(body);
  const [standX, standZ] = place.stand ?? [1.2, -1.5], stand: [number, number] = [place.chest[0] + side * standX, place.chest[2] + standZ];
  let phase: 'creep' | 'fuse' | 'boom' = 'creep', clock = 0, step = 0, blast: ReturnType<typeof explosion> | undefined;
  return {
    update(ctx, dt) {
      clock += dt;
      if (phase === 'creep') {
        step += dt * 8;
        legs.forEach((leg, i) => { leg.rotation.x = Math.sin(step + (i % 2) * Math.PI) * .5; });
        head.rotation.y = Math.sin(clock * .7) * .3;
        if (walk(body, stand, 1.4, dt)) { phase = 'fuse'; clock = 0; legs.forEach(leg => { leg.rotation.x = 0; }); }
        return true;
      }
      if (phase === 'fuse') {
        // Turns to the chest, swells and blinks white faster and faster.
        const t = clock / 1.6, blink = Math.sin(clock * (8 + t * 30)) > 0 ? 1 : 0;
        body.rotation.y += (Math.atan2(place.chest[0] - body.position.x, place.chest[2] - body.position.z) - body.rotation.y) * Math.min(1, dt * 5);
        body.scale.setScalar(1 + t * .18 + blink * t * .06);
        material.color.setScalar(1 + blink * 2.2);
        if (t >= 1) {
          phase = 'boom'; clock = 0; body.visible = false;
          blast = explosion(root, [body.position.x, place.ground + .8, body.position.z]);
          ctx.flash('#fff1d6', .55);
          // The blast is real: whatever stands in the world's physics nearby is thrown.
          ctx.blast([body.position.x, place.ground + .5, body.position.z], 5, 4);
          ctx.gust(.9, -side);
          ctx.host?.tremor(.75, .9); ctx.host?.gust(.9, -side); ctx.host?.light('#ffd9a0', 1, .45);
        }
        return true;
      }
      const going = blast!.update(dt);
      if (!going) { blast!.dispose(); dispose(body); }
      return going;
    },
  };
};

/** Debris thrown out and falling, smoke rising and spreading: a creeper's blast, about 3 seconds. */
function explosion(root: Group, at: readonly [number, number, number]) {
  const count = 90, positions = new Float32Array(count * 3), colors = new Float32Array(count * 3);
  const bits = Array.from({ length: count }, (_, i) => {
    const smoke = i % 3 !== 0, a = Math.random() * Math.PI * 2, up = Math.random();
    const speed = smoke ? 1 + Math.random() * 2.5 : 4 + Math.random() * 5;
    return { smoke, p: [...at], v: [Math.cos(a) * speed * (1 - up * .5), (smoke ? 1 : 3) + up * speed, Math.sin(a) * speed * (1 - up * .5)], shade: .55 + Math.random() * .45 };
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const material = new PointsMaterial({ size: .45, vertexColors: true, transparent: true, depthWrite: false });
  const points = new Points(geometry, material);
  root.add(points);
  let age = 0;
  return {
    update(dt: number): boolean {
      age += dt;
      bits.forEach((bit, i) => {
        if (bit.smoke) { bit.v[1] = bit.v[1]! * (1 - dt * 1.5) + dt * .6; bit.v[0] = bit.v[0]! * (1 - dt * 2); bit.v[2] = bit.v[2]! * (1 - dt * 2); }
        else bit.v[1] = bit.v[1]! - 18 * dt;
        for (let k = 0; k < 3; k++) bit.p[k] = bit.p[k]! + bit.v[k]! * dt;
        if (!bit.smoke && bit.p[1]! < at[1] - .7) { bit.p[1] = at[1] - .7; bit.v = [0, 0, 0]; }
        positions.set(bit.p, i * 3);
        // Smoke goes from the fire's orange to grey; debris is dirt.
        // The first instant is the blast itself: the smoke starts out white-hot.
        const heat = Math.max(0, 1 - age * 2.5), s = bit.shade;
        if (bit.smoke) colors.set([s * (.6 + heat * .9), s * (.58 + heat * .7), s * (.56 + heat * .3)], i * 3);
        else colors.set([.42 * s, .3 * s, .2 * s], i * 3);
      });
      material.opacity = Math.max(0, 1 - Math.max(0, age - 1.4) / 1.6);
      geometry.attributes.position!.needsUpdate = true; geometry.attributes.color!.needsUpdate = true;
      return age < 3;
    },
    dispose() { dispose(points); },
  };
}

/** A rabbit hops across the meadow in short bounds, stopping to look around. */
const rabbit: Start = (root, place, context) => {
  const side = context.rand() < .5 ? -1 : 1, material = mobMaterial();
  const fur = context.rand() < .5 ? '#9b7653' : '#d8d2c6';
  const body = new Group();
  part(body, [4, 4, 6], fur, place, [0, 3, 0], material);
  const head = part(body, [4, 4, 4], fur, place, [0, 6, 3.5], material);
  part(head, [1, 4, 1], fur, place, [-1, 3.5, -.5], material); part(head, [1, 4, 1], fur, place, [1, 3.5, -.5], material);
  part(head, [1, 1, .3], '#1a1210', place, [-1.2, .5, 2.1], material); part(head, [1, 1, .3], '#1a1210', place, [1.2, .5, 2.1], material);
  part(body, [2, 2, 2], '#f2eee6', place, [0, 4, -3.5], material);
  const z = place.chest[2] - 4 - context.rand() * 6;
  body.position.set(-side * 15, place.ground, z); body.rotation.y = side * Math.PI / 2;
  root.add(body);
  let hop = 0, rest = 0, x = body.position.x;
  return {
    update(ctx, dt) {
      if (rest > 0) { rest -= dt; head.rotation.y = Math.sin(rest * 4) * .5; return true; }
      hop += dt / .42;
      body.position.y = place.ground + Math.sin(Math.min(1, hop % 1) * Math.PI) * .45;
      x += side * 2.1 * dt; body.position.x = x;
      if (hop >= 1) { hop = 0; if (ctx.rand() < .25) rest = .8 + ctx.rand() * 1.5; }
      if (Math.abs(x) > 16 && Math.sign(x) === side) { dispose(body); return false; }
      return true;
    },
  };
};

/** A flock in a loose V over the trees, wings beating. */
const flock: Start = (root, place, context) => {
  const side = context.rand() < .5 ? -1 : 1, material = new MeshBasicMaterial({ color: raw('#2a2226') });
  const group = new Group(), birds: { wings: Mesh[]; phase: number }[] = [];
  const count = 5 + Math.floor(context.rand() * 5);
  for (let i = 0; i < count; i++) {
    const bird = new Group(), rank = Math.ceil(i / 2), wing = new BoxGeometry(.5, .05, .22);
    bird.add(new Mesh(new BoxGeometry(.18, .12, .4), material));
    const left = new Mesh(wing, material), right = new Mesh(wing, material);
    left.geometry.translate(0, 0, 0);
    const lp = new Group(), rp = new Group(); left.position.x = -.25; right.position.x = .25; lp.add(left); rp.add(right);
    bird.add(lp, rp);
    bird.position.set(-side * rank * 1.2, (context.rand() - .5) * .6, (i % 2 ? 1 : -1) * rank * 1.3);
    bird.rotation.y = side * Math.PI / 2;
    group.add(bird);
    birds.push({ wings: [lp as unknown as Mesh, rp as unknown as Mesh], phase: context.rand() * 6 });
  }
  group.position.set(-side * 70, place.ground + 14 + context.rand() * 10, place.chest[2] - 25 - context.rand() * 25);
  root.add(group);
  return {
    update(ctx, dt) {
      group.position.x += side * 7 * dt;
      group.position.y += Math.sin(ctx.time * .8) * .3 * dt;
      birds.forEach(bird => { const a = Math.sin(ctx.time * 9 + bird.phase) * .7; bird.wings[0]!.rotation.z = a; bird.wings[1]!.rotation.z = -a; });
      if (Math.abs(group.position.x) > 72 && Math.sign(group.position.x) === side) { dispose(group); return false; }
      return true;
    },
  };
};

/** A villager walks down the road, stops to look at the chest, hmms, and turns off into the meadow. */
const villager: Start = (root, place, context) => {
  const material = mobMaterial(), robe = context.rand() < .5 ? '#6b4b2e' : '#4d5f3a';
  const body = new Group();
  const head = part(body, [8, 10, 8], '#b4846a', place, [0, 29, 0], material);
  part(head, [2, 4, 2], '#9c6d55', place, [0, -2, 5], material);
  part(head, [2, 1, .3], '#2b5c33', place, [-2, 1, 4.1], material); part(head, [2, 1, .3], '#2b5c33', place, [2, 1, 4.1], material);
  part(head, [8, 2, 8.4], '#3b2a20', place, [0, 4.5, 0], material);
  part(body, [8, 12, 6], robe, place, [0, 18, 0], material);
  part(body, [8, 4, 4], robe, place, [0, 19, 4], material);
  const legs = [-2, 2].map(x => part(body, [4, 12, 4], '#4a4a52', place, [x, 12, 0], material, [0, -6, 0]));
  const z0 = place.chest[2] - 44;
  body.position.set(place.road(z0), place.ground, z0);
  root.add(body);
  const side = context.rand() < .5 ? -1 : 1;
  let phase: 'down' | 'look' | 'off' = 'down', clock = 0, step = 0;
  const lookAt = place.chest[2] - 7;
  return {
    update(_ctx, dt) {
      clock += dt;
      if (phase === 'look') {
        head.rotation.x = -.35; head.rotation.y = Math.sin(clock * 2) * .25;
        if (clock > 2.5) { phase = 'off'; head.rotation.set(0, 0, 0); }
        return true;
      }
      step += dt * 6;
      legs.forEach((leg, i) => { leg.rotation.x = Math.sin(step + i * Math.PI) * .45; });
      if (phase === 'down') {
        const z = body.position.z + .6;
        if (walk(body, [place.road(z), z], 1.1, dt) || body.position.z >= lookAt) { phase = 'look'; clock = 0; legs.forEach(leg => { leg.rotation.x = 0; }); }
        return true;
      }
      walk(body, [side * 20, body.position.z - 2], 1.1, dt);
      if (Math.abs(body.position.x) > 18) { dispose(body); return false; }
      return true;
    },
  };
};

/** A star falls across the evening sky. */
const fallingStar: Start = (root, place, context) => {
  const geometry = new BufferGeometry(), material = new LineBasicMaterial({ color: raw('#fff6e0'), transparent: true, fog: false });
  const line = new Line(geometry, material);
  root.add(line);
  const side = context.rand() < .5 ? -1 : 1, from = [side * -120 + (context.rand() - .5) * 60, place.ground + 90 + context.rand() * 30, -260] as const;
  let age = 0;
  return {
    update(_ctx, dt) {
      age += dt;
      const x = from[0] + side * age * 150, y = from[1] - age * 45, head = [x, y, from[2]], tail = [x - side * 22, y + 7, from[2]];
      geometry.setAttribute('position', new BufferAttribute(new Float32Array([...tail, ...head]), 3));
      material.opacity = Math.min(1, age * 6) * Math.max(0, 1 - age / 1.1);
      if (age > 1.1) { dispose(line); return false; }
      return true;
    },
  };
};

const KINDS = { creeper, rabbit, flock, villager, 'falling-star': fallingStar } as const;
export type HappeningKind = keyof typeof KINDS;
const WEIGHTS: Record<HappeningKind, number> = { creeper: 3, rabbit: 2, flock: 2, villager: 2, 'falling-star': 1 };
