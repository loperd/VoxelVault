import { Mesh, MeshBasicMaterial, PointLight } from 'three';
import { MineParts, type Block } from './parts.ts';

export function fortress(p: MineParts): void {
  const gate = p.group('01-fortress-and-portcullis');
  for (const side of [-1, 1]) {
    p.masonry(gate, 'gate-tower', side < 0 ? -15 : 7, 0, -22, 9, 21, 5);
    p.masonry(gate, 'tower-buttress', side < 0 ? -17 : 14, 0, -19, 3, 17, 3);
    for (let y = 2; y < 21; y += 4)
      p.masonry(gate, 'projecting-cornice', side < 0 ? -16 : 7, y, -18, 10, 1, 2);
    for (let x = 0; x < 9; x += 3)
      p.masonry(gate, 'battlement', (side < 0 ? -15 : 7) + x, 21, -22, 2, 2, 4);
  }
  p.masonry(gate, 'lintel', -6, 12, -22, 13, 9, 5);
  for (let x = -6; x < 7; x += 3) p.masonry(gate, 'crown', x, 21, -22, 2, 2, 4);
  const iron: Block[] = [];
  for (let x = -6; x <= 6; x += 1.5)
    iron.push({ x, y: 13, z: -16.8, w: 0.3, h: 12, d: 0.4, color: '#342a24' });
  for (let y = 8; y <= 19; y += 2)
    iron.push({ x: 0, y, z: -16.6, w: 13, h: 0.32, d: 0.45, color: '#493629' });
  p.batch(gate, 'raised-portcullis', iron);
  for (const side of [-1, 1]) {
    p.chain(gate, side * 9, 18, -15.8, 15);
    p.lantern(gate, side * 9, 3, -15.8, 1.2, true);
    p.lantern(gate, side * 6, 10, -15.5, 1, true);
    p.lantern(gate, side * 14, 11, -15.5, 0.9);
  }
  const tunnel = p.group('02-receding-mine-tunnel');
  for (let z = -25; z > -85; z -= 6) {
    for (const side of [-1, 1]) {
      p.masonry(tunnel, 'tunnel-pier', side < 0 ? -6 : 5, 0, z, 2, 9, 2);
      p.lantern(tunnel, side * 4.6, 6, z + 1, 0.65, z % 12 === -1);
    }
    p.masonry(tunnel, 'tunnel-arch', -5, 9, z, 11, 2, 2);
  }
}

/**
 * What the chest can stand on, as masonry cells (x, y, z, then width, height, depth): the landing
 * in front of the gate, the stepped plinth in its middle the chest stands on, the bridge behind.
 * The same cells are drawn and are the physics' ground, so the chest lands on stone that is there.
 */
const FOOTING: readonly (readonly [string, number, number, number, number, number, number])[] = [
  ['chest-landing', -4, -3, -3, 9, 3, 7],
  ['plinth-step', -2, 0, -2, 5, 1, 5],
  ['plinth', -1, 1, -1, 3, 1, 3],
  ['bridge-stone', -24, -3, -16, 49, 3, 9],
];
/** A masonry block is .96 of a cell, its cell centred on the integer point. */
const FACE = 0.48;

/** The top of the chest's plinth: where the chest stands. */
export const PLINTH_TOP = 1 + FACE;

/** The footing as boxes for the physics: each cell range one solid box, as tall as the stone shows. */
export function footing(): { center: [number, number, number]; half: [number, number, number] }[] {
  return FOOTING.map(([, x, y, z, w, h, d]) => ({
    center: [x + (w - 1) / 2, y + (h - 1) / 2, z + (d - 1) / 2],
    half: [(w - 1) / 2 + FACE, (h - 1) / 2 + FACE, (d - 1) / 2 + FACE],
  }));
}

export function cavern(p: MineParts): void {
  const cave = p.group('03-cavern-rock-and-stalactites');
  for (const side of [-1, 1])
    for (let z = -65; z < 20; z += 4) {
      const x = side * (22 + Math.floor(p.rand() * 5));
      p.masonry(cave, 'rock-column', x, -8, z, 4, 26 + Math.floor(p.rand() * 15), 4);
      for (let i = 0; i < 3; i++) p.masonry(cave, 'rock-shelf', x - 2, 4 + i * 9, z, 7, 2, 5);
    }
  for (let i = 0; i < 38; i++) {
    const x = (p.rand() - 0.5) * 60,
      z = -65 + p.rand() * 75;
    p.masonry(cave, 'hanging-rock', x, 28 + p.rand() * 7, z, 2, 3 + Math.floor(p.rand() * 7), 2);
  }
  const floor = p.group('04-chest-dais-and-broken-ravine');
  for (const [name, ...cells] of FOOTING) p.masonry(floor, name, ...cells);
  // A ring of glowing runes on the plinth's lower step lights the chest from below, two lanterns on
  // the landing's front corners keep the middle of the scene out of the dark.
  const rune = new MeshBasicMaterial({ color: '#5fe8f2' });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2,
      mark = new Mesh(p.box, rune);
    mark.position.set(Math.cos(a) * 1.95, 0.5, Math.sin(a) * 1.95);
    mark.rotation.y = -a;
    mark.scale.set(0.22, 0.06, i % 3 ? 0.4 : 0.6);
    floor.add(mark);
  }
  const glow = new PointLight('#4fd8f0', 22, 9, 1.6);
  glow.position.set(0, 1, 2.6);
  floor.add(glow);
  for (const x of [-3.6, 3.6]) p.lantern(floor, x, -0.17, 2.6, 0.8, true);
  for (let i = 0; i < 80; i++) {
    const x = (p.rand() - 0.5) * 52,
      z = p.rand() * 22 - 5;
    if (Math.abs(x) < 7) continue;
    p.masonry(
      floor,
      'ravine-outcrop',
      x,
      -11,
      z,
      2 + Math.floor(p.rand() * 3),
      5 + Math.floor(p.rand() * 6),
      3,
    );
  }
}

export function galleries(p: MineParts): void {
  const g = p.group('05-timber-galleries-and-railway');
  const wood: Block[] = [];
  for (const side of [-1, 1])
    for (let level = 0; level < 2; level++) {
      const x = side * 20,
        y = 4 + level * 10;
      for (let z = -40; z < 16; z += 4) {
        wood.push({ x, y, z, w: 5, h: 0.3, d: 4, color: '#624025' });
        for (const edge of [-1, 1]) {
          wood.push({ x: x + edge * 2, y: y + 1, z, w: 0.3, h: 2.4, d: 0.3, color: '#58351e' });
          wood.push({
            x: x + edge * 2,
            y: y + 1.7,
            z: z + 1.5,
            w: 0.16,
            h: 0.18,
            d: 4,
            color: '#88552e',
          });
        }
        if (z % 8 === 0) {
          wood.push({ x, y: y - 3, z, w: 0.6, h: 6, d: 0.6, color: '#50311d' });
          p.lantern(g, x - side * 2, y + 2.6, z, 0.75);
        }
      }
    }
  for (let x = -27; x <= 27; x += 1.1)
    wood.push({ x, y: 0.1, z: -11, w: 0.35, h: 0.16, d: 3.5, color: '#70462b' });
  p.batch(g, 'timber-and-rail-sleepers', wood);
  p.batch(
    g,
    'steel-rails',
    [-12.2, -9.8].map((z) => ({ x: 0, y: 0.28, z, w: 56, h: 0.15, d: 0.13, color: '#a5a6ad' })),
  );
  for (let z = -80; z < -15; z += 1.2) p.block(g, 0, 0.03, z, 3, 0.15, 0.3, '#624025');
  for (const x of [-1.1, 1.1]) p.block(g, x, 0.16, -48, 0.12, 0.16, 66, '#82848e');
  for (const x of [-18, -11, 11, 18]) {
    p.block(g, x, 0.6, -7.5, 0.55, 2.1, 0.55, '#56351f');
    p.lantern(g, x, 2, -7.5, 1.2, true);
  }
}
