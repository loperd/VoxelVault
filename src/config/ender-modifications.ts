/**
 * Stand-in for the server-configured profile of the reference Ender model. The shape is the wire
 * contract: the server sends this JSON, the client validates it with copyModificationProfile.
 * Node names are the ones inside public/models/ender-chest.glb.
 *
 * Entries tell the chest's story, so the look matches its condition:
 *   damage  — cracks, scuffs, rust/oxidation: their intensity is the part's condition;
 *   ageing  — moss, cobweb, vines, lichen: a chest left lying around for a long time;
 *   weather — snow, frost;   the End — runes, crystals, blight.
 * The effects are inspired by familiar Minecraft blocks; every texture is generated, none is copied.
 */
export const ENDER_REFERENCE_MODIFICATIONS = {
  schemaVersion: 1,
  revision: 'ender-reference-mods-3',
  parts: [
    { id: 'body', label: 'Корпус', nodes: ['Chest_bottom'] },
    { id: 'lid', label: 'Крышка', nodes: ['Chest_top'] },
    { id: 'latch', label: 'Замок', nodes: ['e516d948-1af8-52ff-c195-b07266936ce7'], swing: true },
  ],
  colorZones: [
    { role: 'shell', mode: 'tint', strength: 0.35, nodes: ['Chest_bottom', 'Chest_top'] },
    { role: 'metal', mode: 'tint', strength: 0.5, nodes: ['e516d948-1af8-52ff-c195-b07266936ce7'] },
  ],
  catalog: [
    // damage
    {
      id: 'body-cracks',
      label: 'Трещины корпуса',
      kind: 'fracture',
      parts: ['body'],
      style: {
        branches: 260,
        minLength: 4,
        maxLength: 11,
        drift: 0.4,
        scarColor: '#151d1e',
        scale: 0.25,
      },
    },
    {
      id: 'lid-cracks',
      label: 'Трещины крышки',
      kind: 'fracture',
      parts: ['lid'],
      style: {
        branches: 220,
        minLength: 4,
        maxLength: 9,
        drift: 0.4,
        scarColor: '#151d1e',
        scale: 0.25,
      },
    },
    {
      id: 'shell-scuffs',
      label: 'Потёртости',
      kind: 'wear',
      parts: ['body', 'lid'],
      style: {
        color: '#a3b0ae',
        spots: 520,
        minRadius: 0.4,
        maxRadius: 1.4,
        scratches: 140,
        scale: 0.25,
        anchor: 'edges',
        opacity: 0.38,
      },
    },
    {
      id: 'latch-rust',
      label: 'Ржавый замок',
      kind: 'wear',
      parts: ['latch'],
      style: {
        color: '#b0601f',
        colorEnd: '#6b3416',
        spots: 420,
        minRadius: 1,
        maxRadius: 3,
        scratches: 0,
        scale: 2,
        opacity: 0.92,
      },
    },
    {
      id: 'latch-patina',
      label: 'Окисленный замок',
      kind: 'wear',
      parts: ['latch'],
      style: {
        color: '#b87a4b',
        colorEnd: '#4f9a83',
        spots: 420,
        minRadius: 1,
        maxRadius: 3,
        scratches: 0,
        scale: 2,
        anchor: 'edges',
        opacity: 0.9,
      },
    },
    // ageing
    {
      id: 'moss',
      label: 'Замшелость',
      kind: 'growth',
      parts: ['body', 'lid'],
      style: { type: 'moss', color: '#3a5a2e', scale: 0.25, anchor: 'edges', opacity: 1 },
    },
    {
      id: 'cobweb',
      label: 'Паутина',
      kind: 'growth',
      parts: ['body', 'lid'],
      style: { type: 'cobweb', color: '#d9dbd6', scale: 1, count: 2 },
    },
    {
      id: 'vines',
      label: 'Лианы',
      kind: 'growth',
      parts: ['lid'],
      style: { type: 'vines', color: '#3f6e2a', scale: 1, count: 5 },
    },
    {
      id: 'glow-lichen',
      label: 'Светящийся лишайник',
      kind: 'growth',
      parts: ['body'],
      style: {
        type: 'lichen',
        color: '#5f7445',
        highlight: '#e3cf7a',
        glow: 0.6,
        scale: 0.25,
        anchor: 'bottom',
      },
    },
    // weather
    {
      id: 'snow',
      label: 'Снежная шапка',
      kind: 'growth',
      parts: ['lid'],
      style: { type: 'snow', color: '#dfe7eb', scale: 1, count: 1 },
    },
    {
      id: 'frost',
      label: 'Иней',
      kind: 'growth',
      parts: ['body', 'lid', 'latch'],
      style: {
        type: 'frost',
        color: '#d8e6ee',
        scale: 0.25,
        anchor: 'top',
        spread: 0.5,
        opacity: 0.65,
      },
    },
    // the End
    {
      id: 'void-runes',
      label: 'Руны Края',
      kind: 'glow',
      parts: ['body', 'lid'],
      style: {
        pattern: 'runes',
        density: 0.45,
        color: '#3f8f74',
        scale: 0.5,
        pulse: 0.4,
        brightness: 1,
      },
    },
    {
      id: 'end-crystals',
      label: 'Кристаллы Края',
      kind: 'growth',
      parts: ['lid'],
      style: { type: 'crystals', color: '#8a6db3', glow: 0.3, scale: 1, count: 3 },
    },
    {
      id: 'end-blight',
      label: 'Порча Края',
      kind: 'growth',
      parts: ['body'],
      style: {
        type: 'blight',
        color: '#0d3036',
        highlight: '#3fd6c6',
        glow: 0.5,
        scale: 0.25,
        anchor: 'bottom',
        opacity: 1,
      },
    },
  ],
};
