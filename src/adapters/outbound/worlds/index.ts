import type { WorldId } from '../../../config/cases.ts';
import { RELIC_VAULT } from './relic-vault.ts';
import { MINER_VAULT } from './miner/index.ts';
import type { StageBuilder } from '../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../application/ports/chest-handles.ts';
import { OVERWORLD_BLOCKS } from './overworld-blocks.ts';
import { TRAVELER_SHRINE } from './traveler-shrine.ts';
import { END_3D } from './end-3d.ts';
import { DRAGON_3D } from './dragon-3d.ts';

/** Every world, by id, as a block world (packages/blockworld). */
export const BLOCK_WORLDS: Readonly<Record<WorldId, StageBuilder<ChestHandles>>> = Object.freeze({
  overworld: OVERWORLD_BLOCKS, shrine: TRAVELER_SHRINE, 'deep-mine': MINER_VAULT, end: END_3D, dragon: DRAGON_3D, 'relic-vault': RELIC_VAULT,
});
