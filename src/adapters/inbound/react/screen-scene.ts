import type { SessionState } from '../../../application/session-state.ts';

export type ScreenScene = 'intro' | 'chest' | 'roulette' | 'prize' | 'feedback';
const SCENES: Record<SessionState['phase'], ScreenScene> = {
  idle: 'feedback',
  loading: 'feedback',
  ready: 'intro',
  clearing: 'intro',
  dropping: 'chest',
  opening: 'chest',
  flashing: 'chest',
  spinning: 'roulette',
  settling: 'roulette',
  revealing: 'roulette',
  'prize-visible': 'prize',
  destroyed: 'prize',
  resetting: 'intro',
  failed: 'feedback',
  disposed: 'feedback',
};

export function screenScene(phase: SessionState['phase']): ScreenScene {
  return SCENES[phase];
}
