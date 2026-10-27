/**
 * The world packs a player may pick, by their folder under packs/ (served as is by Vite in
 * development; these alone are copied into the build by vite.config.ts): what is offered, never what is in them.
 * The only place the app names a pack.
 */
export const WORLD_PACKS: Readonly<Record<string, { readonly title: string }>> = Object.freeze({
  'sample-ruin': { title: 'Руины' },
});
