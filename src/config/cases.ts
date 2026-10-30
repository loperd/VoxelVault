import {
  changeChestAppearance,
  createChestAppearance,
  type ChestAppearance,
} from '../domain/chest-appearance.ts';
import {
  copyModificationProfile,
  type ChestModificationProfile,
} from '../domain/chest-modifications.ts';
import { ENDER_REFERENCE_MODIFICATIONS } from './ender-modifications.ts';

export interface CasePresentation {
  readonly brand: string;
  readonly collection: string;
  readonly title: string;
  readonly description: string;
  readonly backgroundPath: string;
  /** The living world the chest stands in (drawn behind it); `backgroundPath` is the still fallback. */
  readonly world: WorldId;
  /** Case identity styling. Kept separate from rarity, which describes possible contents. */
  readonly theme: CaseVisualTheme;
}
/** The worlds a chest can live in. */
export type WorldId = 'overworld' | 'shrine' | 'deep-mine' | 'end' | 'dragon' | 'relic-vault';
export interface CaseVisualTheme {
  readonly accent: string;
  readonly highlight: string;
  readonly deep: string;
  readonly glow: string;
}
export interface ChestModelDefinition {
  readonly revision: string;
  readonly path: string;
  readonly body: string;
  readonly lid: string;
  readonly key?: string;
  readonly openingClips: readonly string[];
  readonly rotationY: number;
  /** Server-configured parts, colour zones and modification catalogue of this model. */
  readonly modifications: ChestModificationProfile;
}
export type CaseRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export interface CaseRarityPalette {
  readonly primary: string;
  readonly highlight: string;
  readonly deep: string;
  readonly glow: string;
}
export const CASE_RARITY_LABELS: Readonly<Record<CaseRarity, string>> = Object.freeze({
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
});
export const CASE_RARITY_PALETTES: Readonly<Record<CaseRarity, CaseRarityPalette>> = Object.freeze({
  common: Object.freeze({
    primary: '#9aa9a0',
    highlight: '#d2ded5',
    deep: '#35483f',
    glow: '#9aa9a055',
  }),
  uncommon: Object.freeze({
    primary: '#5fc78e',
    highlight: '#a8edbd',
    deep: '#195d42',
    glow: '#5fc78e66',
  }),
  rare: Object.freeze({
    primary: '#59a9ef',
    highlight: '#a2d5ff',
    deep: '#174d79',
    glow: '#59a9ef66',
  }),
  epic: Object.freeze({
    primary: '#b887ed',
    highlight: '#e0c0ff',
    deep: '#59357d',
    glow: '#b887ed66',
  }),
  legendary: Object.freeze({
    primary: '#e4b761',
    highlight: '#ffe6a1',
    deep: '#79521a',
    glow: '#e4b76166',
  }),
});
export interface CaseDefinition {
  readonly rarity: CaseRarity;
  readonly appearance: ChestAppearance;
  readonly id: string;
  readonly collectionId: string;
  readonly presentation: CasePresentation;
  readonly model: ChestModelDefinition;
  readonly catalogPath: string;
  readonly poster: string;
}
const MODEL: ChestModelDefinition = Object.freeze({
  revision: 'ender-reference',
  path: 'models/ender-chest.glb',
  body: 'Chest_bottom',
  lid: 'Chest_top',
  openingClips: Object.freeze(['Open']),
  rotationY: Math.PI,
  modifications: copyModificationProfile(ENDER_REFERENCE_MODIFICATIONS),
});

function makeCase(
  id: string,
  collectionId: string,
  rarity: CaseRarity,
  collection: string,
  title: string,
  description: string,
  palette: { shell: string; panel: string; metal: string; accent: string },
  theme: CaseVisualTheme,
  world: WorldId,
  backgroundPath = 'images/cases/ender-environment.png',
): CaseDefinition {
  return Object.freeze({
    appearance: changeChestAppearance(createChestAppearance(id.length * 173), { palette }),
    id,
    collectionId,
    rarity,
    presentation: Object.freeze({
      brand: 'Voxel Vault',
      collection,
      title,
      description,
      backgroundPath,
      world,
      theme: Object.freeze(theme),
    }),
    model: MODEL,
    catalogPath: `api/v1/cases/${id}/catalog`,
    poster: 'images/cases/ender.png',
  });
}
const rarityTheme = (rarity: CaseRarity): CaseVisualTheme => {
  const palette = CASE_RARITY_PALETTES[rarity];
  return {
    accent: palette.primary,
    highlight: palette.highlight,
    deep: palette.deep,
    glow: palette.glow,
  };
};

export const ENDER_CASE: CaseDefinition = Object.freeze({
  appearance: createChestAppearance(),
  id: 'ender',
  collectionId: 'the-end',
  rarity: 'rare',
  presentation: Object.freeze({
    brand: 'Voxel Vault',
    collection: 'Коллекция Края',
    title: 'Сокровища Эндера',
    description: 'Тайны другого измерения. Открой сундук и найди свой артефакт.',
    backgroundPath: 'images/cases/ender-environment.png',
    world: 'end',
    theme: Object.freeze({
      accent: '#59a9ef',
      highlight: '#a2d5ff',
      deep: '#174d79',
      glow: '#59a9ef66',
    }),
  }),
  model: MODEL,
  catalogPath: 'api/v1/cases/ender/catalog',
  poster: 'images/cases/ender.png',
});
const COMMON_CASE = makeCase(
  'traveler',
  'overworld',
  'common',
  'Дороги Верхнего мира',
  'Сундук Путника',
  'Дорожные трофеи, простые инструменты и находки после долгих странствий.',
  { shell: '#493a2b', panel: '#72583a', metal: '#928267', accent: '#9aa9a0' },
  rarityTheme('common'),
  'shrine',
);
const UNCOMMON_CASE = makeCase(
  'deep-mine',
  'deep-mines',
  'uncommon',
  'Глубинные шахты',
  'Кладовая Шахтёра',
  'Снаряжение и редкие минералы из забытых подземных залов.',
  { shell: '#343c3b', panel: '#405c58', metal: '#7b8984', accent: '#5fc78e' },
  // The mine's own accent is the ember orange of its lanterns, not its rarity's green.
  { accent: '#e8833a', highlight: '#ffc08a', deep: '#7a3a14', glow: '#e8833a66' },
  'deep-mine',
  'images/cases/deep-mine-fortress.webp',
);
const EPIC_CASE = makeCase(
  'dragon',
  'dragon-reach',
  'epic',
  'Предел Дракона',
  'Казна Драконоборца',
  'Реликвии древней битвы, пропитанные энергией Края.',
  { shell: '#3a293f', panel: '#58406a', metal: '#9782a0', accent: '#b887ed' },
  rarityTheme('epic'),
  'dragon',
);
/** Authored PBR materials belong to this model; Ender palette zones must not tint them. */
export const RELIC_CASE: CaseDefinition = Object.freeze({
  id: 'relic',
  collectionId: 'quantum-vault',
  rarity: 'legendary',
  appearance: createChestAppearance(),
  presentation: Object.freeze({
    brand: 'Voxel Vault',
    collection: 'Квантовое хранилище',
    title: 'Квантовый реликт',
    description: 'Обсидиановая броня, кристаллическое ядро и технологии забытой цивилизации.',
    backgroundPath: 'images/cases/relic-vault.svg',
    world: 'relic-vault',
    theme: Object.freeze({
      accent: '#51dccb',
      highlight: '#bbfff1',
      deep: '#164c52',
      glow: '#51dccb66',
    }),
  }),
  model: Object.freeze({
    revision: 'relic-v4-8dc4b45a',
    path: 'models/relic-v4-8dc4b45a.glb',
    body: 'Body',
    lid: 'LidAssembly',
    openingClips: Object.freeze(['Vault.Open']),
    rotationY: 0,
    modifications: copyModificationProfile({
      schemaVersion: 1,
      revision: 'relic-v4-authored-pbr',
      parts: [
        { id: 'body', label: 'Корпус', nodes: ['Body'] },
        { id: 'lid', label: 'Крышка', nodes: ['LidAssembly'] },
      ],
      colorZones: [],
      catalog: [],
    }),
  }),
  catalogPath: 'api/v1/cases/relic/catalog',
  poster: 'images/cases/relic-vault.svg',
});
export const CASES: readonly CaseDefinition[] = Object.freeze([
  COMMON_CASE,
  UNCOMMON_CASE,
  ENDER_CASE,
  EPIC_CASE,
  RELIC_CASE,
]);
