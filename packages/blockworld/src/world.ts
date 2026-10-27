/** A box of blocks, one id per cell (0 = air), with the light levels the light pass fills in. */
export class BlockWorld {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  /** Where cell (0,0,0) sits in scene coordinates. */
  readonly origin: readonly [number, number, number];
  private readonly blocks: Uint16Array;
  /** Light levels 0..15 per cell: from the sky and from glowing blocks. */
  readonly sky: Uint8Array;
  readonly glow: Uint8Array;
  /** Block light in the world's second colour (see BlockDefinition.secondLight). */
  readonly glow2: Uint8Array;
  /**
   * The box stands in open air (a world pack's structure): beside it is sky, so sky light comes in
   * through its sides as through its top. Default: beyond the sides is dark, as the built-in worlds
   * have always had it (they are walled or underground to their edges).
   */
  readonly openSides: boolean;

  constructor(
    sx: number,
    sy: number,
    sz: number,
    origin: readonly [number, number, number] = [0, 0, 0],
    options: { openSides?: boolean } = {},
  ) {
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    this.origin = origin;
    this.openSides = options.openSides === true;
    const size = sx * sy * sz;
    this.blocks = new Uint16Array(size);
    this.sky = new Uint8Array(size);
    this.glow = new Uint8Array(size);
    this.glow2 = new Uint8Array(size);
  }

  index(x: number, y: number, z: number): number {
    return x + this.sx * (y + this.sy * z);
  }
  inside(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }
  get(x: number, y: number, z: number): number {
    return this.inside(x, y, z) ? this.blocks[this.index(x, y, z)]! : 0;
  }
  set(x: number, y: number, z: number, block: number): void {
    if (this.inside(x, y, z)) this.blocks[this.index(x, y, z)] = block;
  }
  fill(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    block: number,
  ): void {
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, z, block);
  }
  /** The highest non-air cell of a column, or -1. */
  top(x: number, z: number): number {
    for (let y = this.sy - 1; y >= 0; y--) if (this.get(x, y, z)) return y;
    return -1;
  }
  /** Light at a cell for meshing: above the box is open sky, and beside it too when its sides are open. */
  skyAt(x: number, y: number, z: number): number {
    return this.inside(x, y, z)
      ? this.sky[this.index(x, y, z)]!
      : y >= this.sy || (this.openSides && y >= 0)
        ? 15
        : 0;
  }
  glowAt(x: number, y: number, z: number): number {
    return this.inside(x, y, z) ? this.glow[this.index(x, y, z)]! : 0;
  }
  glow2At(x: number, y: number, z: number): number {
    return this.inside(x, y, z) ? this.glow2[this.index(x, y, z)]! : 0;
  }
}
