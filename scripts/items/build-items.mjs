// Builds the item and character models (public/models/items/*.glb) from the voxel sources below.
// The sources are the originals: rerun `npm run items:build` after changing them; the GLBs are derived.
// Contract every model keeps (checked by tests/adapters/item-models.test.mjs):
// - units: an item fits a unit cube centred on its pivot (the origin); a character is 1 tall, feet at y 0, facing +z;
// - materials are named by kind (`wood`, `metal`, `cloth`, `skin`, `stone`, `glow`); `glow` pulses at runtime;
// - attachment points are empty nodes named `attach_<where>`; equipment nodes are named after the bone they ride.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnimationClip,
  Box3,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
} from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// GLTFExporter reads its binary through FileReader, which Node does not have.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((result) => {
      this.result = result;
      this.onloadend?.();
    });
  }
};

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/models/items');

const MATERIALS = {
  wood: { roughness: 0.85, metalness: 0 },
  metal: { roughness: 0.32, metalness: 0.85 },
  stone: { roughness: 0.7, metalness: 0.1 },
  cloth: { roughness: 0.95, metalness: 0 },
  skin: { roughness: 0.8, metalness: 0 },
  glow: { roughness: 0.4, metalness: 0, emissive: true },
};

/**
 * Voxels: `cells` maps "x,y,z" to [hex colour, material kind]. Faces between a voxel and air are kept,
 * merged greedily into rectangles of one colour; `hidden(x, y, z)` marks space that counts as solid (a body under armour).
 */
export function voxelMesh(cells, unit, hidden = () => false) {
  const groups = new Map(),
    color = new Color(),
    points = [...cells.keys()].map((key) => key.split(',').map(Number));
  const min = [0, 1, 2].map((axis) => Math.min(...points.map((p) => p[axis])));
  const max = [0, 1, 2].map((axis) => Math.max(...points.map((p) => p[axis])) + 1);
  const solid = (p) => cells.has(p.join(',')) || hidden(...p);
  for (let d = 0; d < 3; d++)
    for (const dir of [1, -1]) {
      const u = (d + 1) % 3,
        v = (d + 2) % 3,
        width = max[u] - min[u],
        height = max[v] - min[v];
      for (let s = min[d]; s < max[d]; s++) {
        const mask = new Array(width * height).fill(undefined);
        for (let j = 0; j < height; j++)
          for (let i = 0; i < width; i++) {
            const p = [];
            p[d] = s;
            p[u] = min[u] + i;
            p[v] = min[v] + j;
            const value = cells.get(p.join(','));
            const beyond = [...p];
            beyond[d] += dir;
            if (value && !solid(beyond)) mask[j * width + i] = value.join('|');
          }
        for (let j = 0; j < height; j++)
          for (let i = 0; i < width; i++) {
            const key = mask[j * width + i];
            if (!key) continue;
            let w = 1,
              h = 1;
            while (i + w < width && mask[j * width + i + w] === key) w++;
            grow: while (j + h < height) {
              for (let k = 0; k < w; k++) if (mask[(j + h) * width + i + k] !== key) break grow;
              h++;
            }
            for (let y = 0; y < h; y++)
              for (let x = 0; x < w; x++) mask[(j + y) * width + i + x] = undefined;
            const [hex, kind] = key.split('|');
            let group = groups.get(kind);
            if (!group)
              groups.set(kind, (group = { position: [], normal: [], color: [], index: [] }));
            color.setHex(Number(hex));
            const start = group.position.length / 3,
              normal = [0, 0, 0];
            normal[d] = dir;
            // u × v = d, so the corners run counter-clockwise seen from outside when the face looks along +d.
            const corners = [
              [i, j],
              [i + w, j],
              [i + w, j + h],
              [i, j + h],
            ];
            for (const [cu, cv] of dir > 0 ? corners : corners.reverse()) {
              const p = [];
              p[d] = s + (dir > 0 ? 1 : 0);
              p[u] = min[u] + cu;
              p[v] = min[v] + cv;
              group.position.push(...p.map((c) => c * unit));
              group.normal.push(...normal);
              group.color.push(color.r, color.g, color.b);
            }
            group.index.push(start, start + 1, start + 2, start, start + 2, start + 3);
          }
      }
    }
  const root = new Group();
  for (const [kind, data] of groups) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(data.position, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(data.normal, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(data.color, 3));
    geometry.setIndex(data.index);
    const { emissive, ...surface } = MATERIALS[kind];
    const material = new MeshStandardMaterial({
      name: kind,
      vertexColors: true,
      flatShading: true,
      ...surface,
      ...(emissive ? { emissive: 0xffffff, emissiveIntensity: 1.4 } : {}),
    });
    const mesh = new Mesh(geometry, material);
    mesh.name = `${kind}`;
    root.add(mesh);
  }
  return root;
}

const cell = (cells, x, y, z, hex, kind) => cells.set(`${x},${y},${z}`, [hex, kind]);
const box = (cells, [x0, y0, z0], [x1, y1, z1], paint) => {
  for (let x = x0; x < x1; x++)
    for (let y = y0; y < y1; y++)
      for (let z = z0; z < z1; z++) {
        const value = paint(x, y, z);
        if (value) cell(cells, x, y, z, ...value);
      }
};
const node = (name, ...children) => {
  const object = new Object3D();
  object.name = name;
  if (children.length) object.add(...children);
  return object;
};
const turn = (axis, degrees) =>
  new Quaternion().setFromAxisAngle(new Vector3(...axis), (degrees * Math.PI) / 180).toArray();
/** A looping rotation track: keyframes as [seconds, axis, degrees]. */
const rotation = (name, keys) =>
  new QuaternionKeyframeTrack(
    `${name}.quaternion`,
    keys.map((k) => k[0]),
    keys.flatMap(([, axis, degrees]) => turn(axis, degrees)),
  );

/** Enchanted pickaxe: Minecraft's 16×16 sprite, but a head three voxels deep, a two-tone handle and glowing runes. */
function pickaxe() {
  const cells = new Map();
  for (let t = 1; t <= 11; t++) {
    cell(cells, t, t, 0, 0x8a5a32, 'wood');
    cell(cells, t + 1, t, 0, 0x5b3a1e, 'wood');
  }
  cell(cells, 1, 1, 0, 0x3b2512, 'wood');
  cell(cells, 2, 1, 0, 0x3b2512, 'wood');
  // The head: an arc around a point down the handle, so it crosses the handle's top and its tips point back.
  for (let x = 0; x < 16; x++)
    for (let y = 0; y < 16; y++) {
      const d = Math.hypot(x - 1.5, y - 1.5),
        angle = (Math.atan2(y - 1.5, x - 1.5) * 180) / Math.PI;
      if (Math.abs(d - 12.4) > 1.05 || angle < 12 || angle > 78) continue;
      const tip = angle < 20 || angle > 70,
        outer = d > 12.4,
        rune = !tip && Math.round(angle) % 11 < 3 && outer;
      const [hex, kind] = rune ? [0x7df9ff, 'glow'] : [outer ? 0xd9f2f5 : 0x7fb6c4, 'metal'];
      for (const z of tip ? [0] : [-1, 0, 1])
        cell(cells, x, y, z, z === 0 || rune ? hex : 0x5d8a96, z === 0 || rune ? kind : 'metal');
    }
  return voxelMesh(cells, 1 / 16);
}

/** Magical eye: a voxel eyeball with a glowing iris and four shards in orbit; Idle looks around while the shards circle. */
function eye() {
  const ball = new Map(),
    shards = new Map();
  box(ball, [-6, -6, -6], [6, 6, 6], (x, y, z) => {
    const p = [x + 0.5, y + 0.5, z + 0.5],
      r = Math.hypot(...p),
      across = Math.hypot(p[0], p[1]);
    if (r > 5.9) return null;
    if (p[2] > 3 && across < 1.5) return [0x120a1c, 'stone'];
    if (p[2] > 2 && across < 3.4) return [across < 2.4 ? 0xb46bff : 0x46e0c8, 'glow'];
    return [Math.abs(p[1]) > 4.2 ? 0x3d2a55 : 0xe9e0f2, 'stone'];
  });
  for (const [x, z] of [
    [9, 0],
    [-9, 0],
    [0, 9],
    [0, -9],
  ])
    box(shards, [x - 1, -1, z - 1], [x + 1, 1, z + 1], () => [0xc58cff, 'glow']);
  const root = node(
    'magic_eye',
    node('eye', voxelMesh(ball, 1 / 20)),
    node('orbit', voxelMesh(shards, 1 / 20)),
  );
  const idle = new AnimationClip('Idle', 6, [
    rotation('eye', [
      [0, [0, 1, 0], 0],
      [1.2, [0, 1, 0], 24],
      [2.4, [1, 0, 0], -14],
      [3.6, [0, 1, 0], -24],
      [4.8, [1, 0, 0], 10],
      [6, [0, 1, 0], 0],
    ]),
    rotation('orbit', [
      [0, [0, 1, 0], 0],
      [2, [0, 1, 0], 120],
      [4, [0, 1, 0], 240],
      [6, [0, 1, 0], 360],
    ]),
  ]);
  return { root, animations: [idle] };
}

/** Bones of the shared character, in pixels of a 32-pixel-tall figure: [name, pivot, box from, box to] (boxes relative to pivots). */
const BONES = [
  ['head', [0, 24, 0], [-4, 0, -4], [4, 8, 4]],
  ['body', [0, 12, 0], [-4, 0, -2], [4, 12, 2]],
  ['arm_r', [-6, 22, 0], [-2, -12, -2], [2, 0, 2]],
  ['arm_l', [6, 22, 0], [-2, -12, -2], [2, 0, 2]],
  ['leg_r', [-2, 12, 0], [-2, -12, -2], [2, 0, 2]],
  ['leg_l', [2, 12, 0], [-2, -12, -2], [2, 0, 2]],
];

/** The base character every privilege dresses: skin, simple clothes, an Idle sway and an Inspect gesture. */
function character() {
  const paint = {
    head: (x, y, z) =>
      z === 3 && y === 3 && (x === -3 || x === 2)
        ? [0x2b4fa8, 'skin']
        : z === 3 && y === 1 && x >= -1 && x <= 0
          ? [0x9c5b45, 'skin']
          : y >= 6 || (z <= -3 && y >= 2)
            ? [0x4a2f1c, 'cloth']
            : [0xe0ac86, 'skin'],
    body: (x, y) =>
      y < 2 ? [0x3f2a1a, 'cloth'] : [x === 0 || x === -1 ? 0x2f6f8f : 0x3a8bb0, 'cloth'],
    arm_r: (x, y) => (y < -9 ? [0xe0ac86, 'skin'] : [0x3a8bb0, 'cloth']),
    arm_l: (x, y) => (y < -9 ? [0xe0ac86, 'skin'] : [0x3a8bb0, 'cloth']),
    leg_r: (x, y) => (y < -10 ? [0x2b2b2b, 'cloth'] : [0x3b3f73, 'cloth']),
    leg_l: (x, y) => (y < -10 ? [0x2b2b2b, 'cloth'] : [0x3b3f73, 'cloth']),
  };
  const root = node('character');
  for (const [name, pivot, from, to] of BONES) {
    const cells = new Map();
    box(cells, from, to, paint[name]);
    const bone = node(name, voxelMesh(cells, 1 / 32));
    bone.position.set(...pivot.map((v) => v / 32));
    if (name === 'arm_r') {
      const hand = node('attach_hand_r');
      hand.position.set(0, -11 / 32, 0);
      bone.add(hand);
    }
    if (name === 'head') {
      const top = node('attach_head');
      top.position.set(0, 8 / 32, 0);
      bone.add(top);
    }
    root.add(bone);
  }
  const idle = new AnimationClip('Idle', 4, [
    rotation('arm_r', [
      [0, [1, 0, 0], 4],
      [2, [1, 0, 0], -4],
      [4, [1, 0, 0], 4],
    ]),
    rotation('arm_l', [
      [0, [1, 0, 0], -4],
      [2, [1, 0, 0], 4],
      [4, [1, 0, 0], -4],
    ]),
    rotation('head', [
      [0, [0, 1, 0], 0],
      [1, [0, 1, 0], 8],
      [3, [0, 1, 0], -8],
      [4, [0, 1, 0], 0],
    ]),
  ]);
  const inspect = new AnimationClip('Inspect', 2.4, [
    rotation('arm_r', [
      [0, [1, 0, 0], 0],
      [0.6, [1, 0, 0], -110],
      [1.8, [1, 0, 0], -110],
      [2.4, [1, 0, 0], 0],
    ]),
    rotation('head', [
      [0, [1, 0, 0], 0],
      [0.6, [1, 0, 0], -12],
      [1.8, [1, 0, 0], -12],
      [2.4, [1, 0, 0], 0],
    ]),
  ]);
  return { root, animations: [idle, inspect] };
}

/** Knight armour: a one-voxel shell around head, body, arms and legs, each piece named after the bone it rides. */
function knightArmour() {
  const steel = 0xb8c4cc,
    trim = 0xe4b549,
    dark = 0x6d7a84;
  const pieces = {
    head: (x, y, z) =>
      z === 4 && y >= 2 && y <= 4 && x >= -3 && x <= 2
        ? null
        : y === 8
          ? [trim, 'metal']
          : [y < 2 ? dark : steel, 'metal'],
    body: (x, y) => (y === 11 || y === 3 ? [trim, 'metal'] : y < 3 ? null : [steel, 'metal']),
    arm_r: (x, y) => (y < -5 ? null : [y === 0 ? trim : steel, 'metal']),
    arm_l: (x, y) => (y < -5 ? null : [y === 0 ? trim : steel, 'metal']),
    leg_r: (x, y) => (y > -3 || y < -9 ? null : [dark, 'metal']),
    leg_l: (x, y) => (y > -3 || y < -9 ? null : [dark, 'metal']),
  };
  const root = node('armor_knight');
  for (const [name, , from, to] of BONES) {
    const cells = new Map(),
      inside = (x, y, z) =>
        x >= from[0] && x < to[0] && y >= from[1] && y < to[1] && z >= from[2] && z < to[2];
    box(
      cells,
      from.map((v) => v - 1),
      to.map((v) => v + 1),
      (x, y, z) => (inside(x, y, z) ? null : pieces[name](x, y, z)),
    );
    root.add(node(name, voxelMesh(cells, 1 / 32, inside)));
  }
  return root;
}

/** Centres an item on its pivot and scales it into the unit cube (characters are built to size). */
function normalized(root) {
  const bounds = new Box3().setFromObject(root, true);
  const size = bounds.max.clone().sub(bounds.min),
    centre = bounds.min.clone().add(bounds.max).multiplyScalar(0.5);
  const scale = 1 / Math.max(size.x, size.y, size.z),
    holder = node(root.name || 'item');
  root.name = `${holder.name}_model`;
  root.position.copy(centre).multiplyScalar(-scale);
  root.scale.setScalar(scale);
  holder.add(root);
  return holder;
}

async function save(name, root, animations = []) {
  const glb = await new GLTFExporter().parseAsync(root, { binary: true, animations });
  await writeFile(resolve(OUT, `${name}.glb`), Buffer.from(glb));
  console.log(`${name}.glb  ${glb.byteLength} bytes`);
}

await mkdir(OUT, { recursive: true });
await save('enchanted-pickaxe', normalized(node('enchanted_pickaxe', pickaxe())));
const magic = eye();
await save('magic-eye', normalized(magic.root), magic.animations);
const base = character();
await save('character', base.root, base.animations);
// Pieces as the file's top-level nodes: each one rides the bone of its name.
await save('armor-knight', [...knightArmour().children]);
