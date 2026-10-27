import {
  BlockWorld,
  type Stage,
  type StageBuilder,
} from '../../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../../application/ports/chest-handles.ts';
import { id, onTop, render } from './kit.ts';

/**
 * A lighting test bench, not a scene: a dark stone room, the chest on one block, and one glowstone
 * that is the only light — on the blocks (block light) and on the chest (its key, from the same
 * place). Seen three-quarters, so the chest shows its top, front and side.
 */
const S = 17,
  C = 8;

/** `follow` false: the chest keeps its own key, as before GuestLight.from — the mismatch, for comparison. */
export function lightTest(
  lamp: readonly [number, number, number],
  follow = true,
): StageBuilder<ChestHandles> {
  return {
    id: `light-test-${lamp.join('-')}-${follow}`,
    build(): Stage<ChestHandles> {
      const w = new BlockWorld(S, 12, S, [-C, -1, -C]);
      w.fill(0, 0, 0, S - 1, 11, S - 1, id('stone'));
      w.fill(1, 1, 1, S - 2, 10, S - 2, 0);
      w.fill(1, 0, 1, S - 2, 0, S - 2, id('stone_bricks'));
      w.set(C, 1, C, id('stone_bricks'));
      w.set(...lamp, id('glowstone'));
      const root = render(w, { glow: [1, 0.78, 0.55], minimum: 0.02, occlusion: 0.8 });
      const anchor = onTop(w, C, 1, C),
        at = onTop(w, ...lamp);
      return {
        root,
        living: [],
        calm: 0,
        flicker: 0,
        sky: { top: '#000000', horizon: '#000000', bottom: '#000000' },
        fog: { color: '#000000', near: 40, far: 80 },
        camera: {
          position: [anchor[0] + 3.2, anchor[1] + 2.4, anchor[2] + 4.2],
          target: [anchor[0], anchor[1] + 0.45, anchor[2]],
          fov: 50,
          drift: 0,
          focus: [0.5, 0.5],
        },
        anchor,
        ground: { floor: anchor[1] },
        light: {
          sky: '#2a2a30',
          ground: '#141414',
          key: '#ffd9a8',
          ...(follow
            ? {
                from: [at[0] - anchor[0], at[1] - 0.5 - anchor[1], at[2] - anchor[2]] as const,
                keyStrength: 6,
                fillStrength: 0.5,
              }
            : {}),
        },
      };
    },
  };
}
