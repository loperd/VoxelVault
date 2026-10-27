/**
 * The blocks a world is made of. Every block fills exactly one cell of the grid; its model decides
 * how it is drawn inside that cell: a full cube, a cross of two planes (flowers, grass), a torch, a
 * liquid surface, or a few boxes (slabs, stairs, posts, lanterns, chains, candles: the game's
 * non-cube models). Ids are given in registration order, 0 is air.
 */
export type BlockModel = 'cube' | 'cross' | 'torch' | 'liquid' | 'boxes';

/** A box inside the cell, in sixteenths: [x0, y0, z0, x1, y1, z1], 0..16. */
export type BlockBox = readonly [number, number, number, number, number, number];

/** The six sides of a cell: north is −z, south +z, east +x, west −x (as in the game). */
export type BlockSide = 'north' | 'south' | 'east' | 'west' | 'up' | 'down';
export const BLOCK_SIDES: readonly BlockSide[] = ['north', 'south', 'east', 'west', 'up', 'down'];

/**
 * Atlas tiles of a block. Each side takes, in order: its own name, then `top` (up), `bottom` (down;
 * then `top`) or `side` (the four around), then `all`.
 */
export interface BlockTextures {
  readonly all?: string;
  readonly top?: string;
  readonly bottom?: string;
  readonly side?: string;
  readonly north?: string;
  readonly south?: string;
  readonly east?: string;
  readonly west?: string;
  readonly up?: string;
  readonly down?: string;
}

/**
 * One face of a part: its own tile (default the block's tile for that side) and the part of the tile
 * it shows, [u0, v0, u1, v1] in tile pixels from the top-left, 0..16, as the game's models give it
 * (u0 > u1 mirrors). Without `uv` the face shows the part of the tile its box covers.
 */
export interface PartFace {
  readonly texture?: string;
  readonly uv?: readonly [number, number, number, number];
}

/** A box of a `boxes` model with faces of its own: from and to in sixteenths, 0..16. */
export interface BlockPart {
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
  readonly faces?: { readonly [side in BlockSide]?: PartFace };
}

export interface BlockDefinition {
  readonly name: string;
  readonly model?: BlockModel;
  /** Atlas tiles: `all`, per face group `top` / `bottom` / `side`, or per side (see BlockTextures). */
  readonly textures: BlockTextures;
  /**
   * Light and neighbouring faces pass through (leaves, glass). A cube that is not transparent is
   * opaque: it stops light and hides the faces of its neighbours.
   */
  readonly transparent?: boolean;
  /** Pixels with no alpha are holes (leaves): drawn in the opaque pass with alpha test. */
  readonly cutout?: boolean;
  /** Light it gives, 0..15 (torch 14, lava 15, glowstone 15). */
  readonly light?: number;
  /** Its light is the world's second colour (soul fire beside fire), not the first. */
  readonly secondLight?: boolean;
  /** The boxes of a `boxes` model; each face shows its own part of the tile, or the tile and UV it names. */
  readonly boxes?: readonly (BlockBox | BlockPart)[];
}

export interface Block extends Required<Omit<BlockDefinition, 'textures' | 'boxes'>> {
  readonly id: number;
  /** A tile for every side, plus `side` for the models drawn without sides (crosses, torches). */
  readonly textures: { readonly [side in BlockSide | 'top' | 'bottom' | 'side']: string };
  readonly boxes: readonly BlockPart[];
  /** Stops light and hides neighbouring faces. */
  readonly opaque: boolean;
}

export class BlockRegistry {
  private readonly blocks: Block[] = [];
  private readonly ids = new Map<string, number>();

  /**
   * `strict`: a side with no tile is an error. Otherwise it shows `stone`, as the built-in worlds
   * have always had it; a world pack is always strict, never silently stone.
   */
  constructor(definitions: readonly BlockDefinition[], options: { strict?: boolean } = {}) {
    for (const definition of definitions) {
      const id = this.blocks.length + 1,
        model = definition.model ?? 'cube',
        t = definition.textures;
      const missing = (side: string) => {
        if (options.strict)
          throw new Error(`Block "${definition.name}" has no texture for its ${side} side.`);
        return 'stone';
      };
      const side = t.side ?? t.all,
        top = t.top ?? t.all ?? side,
        bottom = t.bottom ?? t.all ?? t.top ?? side;
      const sides = {
        north: t.north ?? side ?? missing('north'),
        south: t.south ?? side ?? missing('south'),
        east: t.east ?? side ?? missing('east'),
        west: t.west ?? side ?? missing('west'),
        up: t.up ?? top ?? missing('up'),
        down: t.down ?? bottom ?? missing('down'),
      };
      const block: Block = {
        id,
        name: definition.name,
        model,
        textures: { ...sides, top: sides.up, bottom: sides.down, side: side ?? sides.north },
        transparent: definition.transparent ?? model !== 'cube',
        cutout: definition.cutout ?? false,
        light: Math.max(0, Math.min(15, definition.light ?? 0)),
        secondLight: definition.secondLight ?? false,
        boxes: (definition.boxes ?? []).map((box) =>
          'from' in box ? box : { from: [box[0], box[1], box[2]], to: [box[3], box[4], box[5]] },
        ),
        opaque: model === 'cube' && !(definition.transparent ?? false),
      };
      if (this.ids.has(block.name)) throw new Error(`Block "${block.name}" is defined twice.`);
      this.blocks.push(block);
      this.ids.set(block.name, id);
    }
  }

  /** The id of a block by name; throws on a typo rather than silently placing air. */
  id(name: string): number {
    const id = this.ids.get(name);
    if (id === undefined) throw new Error(`Unknown block "${name}".`);
    return id;
  }

  get(id: number): Block | undefined {
    return id > 0 ? this.blocks[id - 1] : undefined;
  }
}
