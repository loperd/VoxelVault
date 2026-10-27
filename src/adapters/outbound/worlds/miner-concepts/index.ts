import type { StageBuilder } from '../../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../../application/ports/chest-handles.ts';
import { MINER_SINKHOLE } from './sinkhole.ts';
import { MINER_GALLERY } from './gallery.ts';
import { MINER_GEODE } from './geode.ts';

/** Three composition studies for the deep mine, for review only: none is wired to the case yet. */
export const MINER_CONCEPTS: Readonly<Record<string, StageBuilder<ChestHandles>>> = Object.freeze({
  'concept-sinkhole': MINER_SINKHOLE,
  'concept-gallery': MINER_GALLERY,
  'concept-geode': MINER_GEODE,
});
