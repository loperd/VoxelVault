import { CanvasTexture, DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';
import { MineParts, type Block } from './parts.ts';

export function miningProps(p: MineParts): void {
  const props = p.group('06-minecarts-crates-and-tools');
  for (const [x, z] of [
    [-22, -11],
    [23, -11],
    [17, 5],
  ] as const) {
    const cart = p.group(`minecart-${x}`);
    cart.position.set(x, 0.8, z);
    const blocks: Block[] = [{ x: 0, y: -0.3, z: 0, w: 2.4, h: 0.2, d: 1.6, color: '#4f3a29' }];
    for (const side of [-1, 1]) {
      blocks.push({ x: 0, y: 0.3, z: side * 0.8, w: 2.5, h: 1.1, d: 0.15, color: '#825b37' });
      blocks.push({ x: side * 1.2, y: 0.3, z: 0, w: 0.15, h: 1.1, d: 1.6, color: '#67462d' });
      for (const end of [-1, 1]) {
        blocks.push({
          x: side * 1.21,
          y: 0.3,
          z: end * 0.65,
          w: 0.16,
          h: 1.3,
          d: 0.16,
          color: '#37363a',
        });
        blocks.push({
          x: side * 0.8,
          y: -0.6,
          z: end * 0.85,
          w: 0.45,
          h: 0.45,
          d: 0.2,
          color: '#27262a',
        });
      }
    }
    for (let i = 0; i < 12; i++)
      blocks.push({
        x: (p.rand() - 0.5) * 1.8,
        y: 0.7 + p.rand() * 0.4,
        z: p.rand() - 0.5,
        w: 0.4,
        h: 0.4,
        d: 0.4,
        color: i % 3 ? '#34363e' : '#36d5ec',
      });
    p.batch(cart, 'cart-body-and-ore', blocks);
  }
  for (let i = 0; i < 14; i++) {
    const x = (i % 2 ? -1 : 1) * (12 + p.rand() * 9),
      z = -17 + p.rand() * 18;
    const crate = [{ x, y: 0.6, z, w: 1.1, h: 1.2, d: 1.1, color: '#62452b' }];
    for (const dy of [0.15, 1.05])
      crate.push({ x, y: dy, z: z + 0.57, w: 1.25, h: 0.15, d: 0.12, color: '#987049' });
    p.batch(props, 'supply-crates', crate);
  }
  const banners = p.group('07-miners-guild-banners');
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#721e19';
  ctx.beginPath();
  ctx.moveTo(2, 0);
  ctx.lineTo(62, 0);
  ctx.lineTo(62, 110);
  ctx.lineTo(32, 128);
  ctx.lineTo(2, 110);
  ctx.fill();
  ctx.strokeStyle = '#b87b32';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = '#d7a353';
  ctx.lineWidth = 5;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(32 - side * 17, 78);
    ctx.lineTo(32 + side * 12, 43);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(32 + side * 2, 40);
    ctx.lineTo(32 + side * 15, 44);
    ctx.lineTo(32 + side * 22, 56);
    ctx.stroke();
  }
  const texture = new CanvasTexture(canvas);
  for (const side of [-1, 1]) {
    const banner = new Mesh(
      new PlaneGeometry(2.3, 5.5, 8, 16),
      new MeshBasicMaterial({ map: texture, transparent: true, side: DoubleSide }),
    );
    banner.name = 'embroidered-crossed-pickaxes';
    banner.position.set(side * 12.3, 13.6, -15.8);
    banners.add(banner);
  }
}
