/**
 * How items look in 3D: presentation only. The server owns what an item is, its rarity and who has it;
 * this maps an item id to its model and how to show it. An item without an entry is shown by its image.
 *
 * The model file carries geometry, materials (named by kind; `glow` pulses), animations and attachment
 * points (`attach_*` nodes), already centred and scaled (see scripts/items/build-items.mjs). This entry
 * adds what the file cannot say: the first view, the light, which clips to play and how to dress it.
 */
export interface ModelRef {
  readonly path: string;
  readonly revision: string;
}

export type ItemLight = 'studio' | 'void' | 'hall';

export interface HeldItem {
  /** The attachment node it is held at, and the item (an id in ITEM_VISUALS) held there. */
  readonly at: string;
  readonly item: string;
  readonly scale: number;
  /** Euler degrees, then an offset in the holder's units, that put the item in the hand. */
  readonly turn: readonly [number, number, number];
  readonly offset?: readonly [number, number, number];
}

export interface ItemVisual {
  readonly model: ModelRef;
  /** Equipment: every node of these models rides the bone of the same name in `model` (one base, many outfits). */
  readonly wear?: readonly ModelRef[];
  readonly hold?: readonly HeldItem[];
  /** First view: degrees around from the front and above; the camera then frames the model's bounds. */
  readonly view: { readonly azimuth: number; readonly elevation: number };
  readonly light: ItemLight;
  /** Clips by name: looped while shown, and played once when the item is first inspected. */
  readonly idle?: string;
  readonly inspect?: string;
  /** Minecraft's enchantment glint over the whole model. */
  readonly enchanted?: boolean;
}

const model = (name: string, revision = '1'): ModelRef =>
  Object.freeze({ path: `models/items/${name}.glb`, revision });

/** Items modelled from one picture (scripts/items/voxelize_item.py): the art is drawn from the front and a little above. */
const fromArt = (id: string, elevation = 12): ItemVisual => ({
  model: model(id),
  light: 'studio',
  idle: 'Idle',
  inspect: 'Inspect',
  view: { azimuth: 20, elevation },
});
/** Lying flat in the model (a map, a blade): the art looks down on them, so the first view does too. */
const FLAT = new Set([
  'mine-drill',
  'mine-pick',
  'mine-tunnels',
  'traveler-guard-sword',
  'traveler-map',
  'traveler-pick',
  'traveler-route',
]);
const ART_ITEMS = Object.freeze(
  Object.fromEntries(
    [
      'traveler-compass',
      'traveler-cloak',
      'traveler-lantern',
      'traveler-route',
      'traveler-pick',
      'traveler-windrose',
      'traveler-wolfcloak',
      'traveler-guard-sword',
      'traveler-wick',
      'traveler-tracker-eye',
      'traveler-map',
      'mine-crystal',
      'mine-lantern',
      'mine-pick',
      'mine-quartz',
      'mine-helmet-lamp',
      'mine-emerald-vein',
      'mine-cloak',
      'mine-tunnels',
      'mine-drill',
      'dragon-ember',
      'mine-amethyst',
      'relic-capacitor',
      'relic-core-fragment',
      'relic-diadem',
      'relic-phase-blade',
      'relic-probe',
    ].map((id) => [id, fromArt(id, FLAT.has(id) ? 60 : undefined)]),
  ),
);

export const ITEM_VISUALS: Readonly<Record<string, ItemVisual>> = Object.freeze({
  ...ART_ITEMS,
  'traveler-pickaxe': {
    model: model('enchanted-pickaxe'),
    view: { azimuth: 18, elevation: 8 },
    light: 'studio',
    enchanted: true,
  },
  'ender-void-eye': {
    model: model('magic-eye'),
    view: { azimuth: 12, elevation: 6 },
    light: 'void',
    idle: 'Idle',
  },
  // A privilege is an item like any other; the knight is one voxel model (from its turnaround sheet), nothing held.
  'privilege-knight': {
    model: model('knight', '8'),
    light: 'hall',
    idle: 'Idle',
    inspect: 'Inspect',
    view: { azimuth: 24, elevation: 6 },
  },
});
