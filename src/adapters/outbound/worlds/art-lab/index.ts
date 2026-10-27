import type { StageBuilder } from '../../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../../application/ports/chest-handles.ts';
import { ART_SHRINE } from './shrine.ts';
import { ART_ISLAND } from './island.ts';
import { ART_CRYPT, crypt } from './crypt.ts';
import { ART_CAMP } from './camp.ts';
import { lightTest } from './light-test.ts';
import { ANCIENT_OUTWARD, ANCIENT_THRESHOLD } from './ancient.ts';
import { FRAME_STUDY } from './frame-study.ts';
import { SCHEMATICS, imported } from './imported.ts';

/** Candidate settings for a chest, made by the art-direction experiment; review only, not in the game. */
export const ART_LAB: Readonly<Record<string, StageBuilder<ChestHandles>>> = Object.freeze({
  'art-shrine': ART_SHRINE,
  'art-island': ART_ISLAND,
  'art-crypt': ART_CRYPT,
  'art-camp': ART_CAMP,
  // The crypt's art-direction iterations (see crypt.ts): what was tried, in order, and the result.
  'art-crypt-1': crypt({ key: true }),
  'art-crypt-2': crypt({ key: true, cold: true }),
  'art-crypt-3': crypt({ key: true, cold: true, ribs: 1 }),
  'art-crypt-final': crypt({ cold: true, ribs: 2 }),
  'ancient-threshold': ANCIENT_THRESHOLD,
  'ancient-outward': ANCIENT_OUTWARD,
  // One frame, two lamps: the glowstone and the chest's key move together (GuestLight.from).
  'light-test-a': lightTest([4, 5, 10]),
  'light-test-b': lightTest([12, 2, 5]),
  // The import experiment: third-party builds converted into research/schematics (local only; absent, no scenes).
  ...(SCHEMATICS['dungeon-entrance']
    ? {
        'import-dungeon-overview': imported('dungeon-entrance', {
          cutaway: { roof: 20, shell: 'blackstone' },
        }),
        'import-dungeon-diagnose': imported('dungeon-entrance', {
          cutaway: { roof: 20, shell: 'blackstone' },
          diagnose: true,
        }),
        'import-dungeon-chest': imported('dungeon-entrance', {
          chest: { cell: [11, 2, 23], eye: [12, 4, 28], lamp: [17, 5, 23], fov: 55 },
        }),
      }
    : {}),
  // The Visual Design experiment's geometry study of the ancient frame (artifacts/visual-design/).
  ...FRAME_STUDY,
  'light-test-a-old': lightTest([4, 5, 10], false),
  'light-test-b-old': lightTest([12, 2, 5], false),
});
