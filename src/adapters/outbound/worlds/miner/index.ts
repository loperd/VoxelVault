import { HemisphereLight } from 'three';
import type { StageBuilder } from '../../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../../application/ports/chest-handles.ts';
import { MineParts } from './parts.ts';
import { cavern, footing, fortress, galleries, PLINTH_TOP } from './architecture.ts';
import { miningProps } from './props.ts';
import { atmosphere } from './atmosphere.ts';

/** The cavern's light: a blue-grey from above, the rust of the rock below, the lanterns' warm glow. */
const LIGHT = { sky: '#6c87b4', ground: '#724025', key: '#ffb37a', from: [0.35, 0.6, 1] as const };

/** An independent, entirely geometric stage for the miner chest. No backdrop image. */
export const MINER_VAULT: StageBuilder<ChestHandles> = {
  id: 'miner-vault-fortress-v3',
  build(seed) {
    let state = seed >>> 0;
    const p = new MineParts(() => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    });
    cavern(p);
    fortress(p);
    galleries(p);
    miningProps(p);
    const living = atmosphere(p);
    p.flush();
    p.root.add(new HemisphereLight(LIGHT.sky, LIGHT.ground, 1.7));
    return {
      root: p.root,
      living,
      calm: 0.02,
      sky: { top: '#0a1221', horizon: '#182132', bottom: '#100c10' },
      fog: { color: '#202332', near: 27, far: 100 },
      // The chest falls onto its plinth in front of the gate (the physics' ground is the stone that is
      // drawn) and is lit in the cavern's colours; the camera stands 5.8 blocks off, the gate framing it.
      // Keep the floating preview above the intro controls, which start halfway down the screen.
      camera: {
        position: [0, PLINTH_TOP + 2.4, 5.8],
        target: [0, PLINTH_TOP + 0.75, 0],
        fov: 50,
        drift: 0.1,
        focus: [0.5, 0.39],
      },
      anchor: [0, PLINTH_TOP, 0],
      ground: { boxes: footing() },
      light: LIGHT,
      flicker: 0.1,
    };
  },
};
