import {
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PointLight,
  TorusGeometry,
} from 'three';

export type Block = {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: string;
};
/** Each component owns a named group; repeated masonry is batched into a single draw call. */
export class MineParts {
  readonly root = new Group();
  readonly stone = new MeshLambertMaterial({ color: '#ffffff' });
  readonly box = new BoxGeometry(1, 1, 1);
  readonly rand: () => number;
  private readonly batches = new Map<Group, Block[]>();
  constructor(rand: () => number) {
    this.rand = rand;
    this.root.name = 'miner-vault';
  }
  group(name: string): Group {
    const g = new Group();
    g.name = name;
    this.root.add(g);
    return g;
  }
  batch(parent: Group, _name: string, blocks: Block[]): void {
    const pending = this.batches.get(parent) ?? [];
    pending.push(...blocks);
    this.batches.set(parent, pending);
  }
  flush(): void {
    for (const [parent, blocks] of this.batches) this.makeBatch(parent, blocks);
    this.batches.clear();
  }
  private makeBatch(parent: Group, blocks: Block[]): void {
    const name = `${parent.name}-masonry-and-fittings`;
    const mesh = new InstancedMesh(this.box, this.stone, blocks.length);
    mesh.name = name;
    const dummy = new Object3D();
    blocks.forEach((b, i) => {
      dummy.position.set(b.x, b.y, b.z);
      dummy.scale.set(b.w, b.h, b.d);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, new Color(b.color));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
  }
  block(
    parent: Group,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: string,
  ): void {
    this.batch(parent, 'block', [{ x, y, z, w, h, d, color }]);
  }
  masonry(
    parent: Group,
    name: string,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
  ): void {
    const blocks: Block[] = [];
    for (let iy = 0; iy < h; iy++)
      for (let ix = 0; ix < w; ix++)
        for (let iz = 0; iz < d; iz++) {
          // Internal cells never contribute to the silhouette.
          if (ix > 0 && ix < w - 1 && iy > 0 && iy < h - 1 && iz > 0 && iz < d - 1) continue;
          const tone = new Color('#45444d').multiplyScalar(0.65 + this.rand() * 0.65);
          blocks.push({
            x: x + ix,
            y: y + iy,
            z: z + iz,
            w: 0.96,
            h: 0.96,
            d: 0.96,
            color: `#${tone.getHexString()}`,
          });
        }
    this.batch(parent, name, blocks);
  }
  lantern(parent: Group, x: number, y: number, z: number, scale = 1, light = false): Group {
    const g = new Group();
    g.name = 'iron-lantern';
    g.position.set(x, y, z);
    g.scale.setScalar(scale);
    parent.add(g);
    const bars: Block[] = [];
    for (const sy of [-1, 1])
      bars.push({ x: 0, y: sy * 0.37, z: 0, w: 0.65, h: 0.12, d: 0.65, color: '#473020' });
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        bars.push({
          x: sx * 0.26,
          y: 0,
          z: sz * 0.26,
          w: 0.075,
          h: 0.7,
          d: 0.075,
          color: '#30231b',
        });
    this.batch(g, 'cage', bars);
    const flame = new Mesh(this.box, new MeshBasicMaterial({ color: '#ffc16a' }));
    flame.scale.set(0.42, 0.55, 0.42);
    g.add(flame);
    if (light) {
      const lamp = new PointLight('#ff8e36', 65, 15, 1.7);
      g.add(lamp);
    }
    return g;
  }
  chain(parent: Group, x: number, top: number, z: number, length: number): void {
    const geometry = new TorusGeometry(0.13, 0.035, 4, 6);
    const mesh = new InstancedMesh(geometry, this.stone, Math.ceil(length / 0.23));
    mesh.name = 'individual-chain-links';
    for (let i = 0; i < mesh.count; i++) {
      const matrix = new Matrix4().makeRotationY(((i % 2) * Math.PI) / 2);
      matrix.setPosition(x, top - i * 0.23, z);
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, new Color('#302b29'));
    }
    parent.add(mesh);
  }
}
