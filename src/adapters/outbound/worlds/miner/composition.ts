/** Camera and structural contract. X right, Y up, forward -Z; bridge deck top Y=0. */
export const MINE_COMPOSITION = {
  camera: { position: [0, 9, 31], target: [0, 3.5, -24], fov: 51, drift: 0, focus: [0.5, 0.5] },
  fortress: { front: -19, back: -31, halfWidth: 18, crown: 27 },
  portal: { halfWidth: 5, spring: 7, crown: 11 },
  bridge: { left: -34, right: 34, front: -7, back: -12, deck: 0, foot: -18 },
  tunnel: { mouth: -31, end: -133, bay: 8 },
  anchor: [0, -0.5, -1],
  zones: { foreground: [14, 27], hero: [-31, -7], background: [-75, -32], distant: [-160, -76] },
} as const;
