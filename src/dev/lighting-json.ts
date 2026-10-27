import { readLightingPreset, type LightingPreset } from '../../packages/blockworld/src/index.ts';

/**
 * A preset as the lab saves it: `{ "base": <from>, ...what changed, "name" }` — the lighting preset
 * contract's own form (readLightingPreset merges it back), so reading it gives `preset` again. The
 * whole preset when there is nothing to start from, or when a change cannot say it: a merge adds and
 * replaces keys, it never removes one (a sun without the base's `reach`).
 */
export function presetJson(
  preset: LightingPreset,
  from: LightingPreset | undefined,
  name = from ? `${from.name}-custom` : preset.name,
): Record<string, unknown> {
  const whole = { ...preset, name };
  if (!from) return whole;
  const change = { base: from.name, ...changes(from, preset), name };
  const same =
    JSON.stringify(readLightingPreset(change, (n) => (n === from.name ? from : undefined))) ===
    JSON.stringify(readLightingPreset(whole));
  return same ? change : whole;
}

/** What `to` changes of `from`: objects key by key, anything else whole. */
function changes(from: unknown, to: unknown): any {
  if (!plain(from) || !plain(to)) return to;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(to)) {
    const was = from[key];
    if (same(was, value)) continue;
    out[key] = plain(was) && plain(value) ? changes(was, value) : value;
  }
  return out;
}

/** Equal as JSON, whatever the order of keys (a preset read back orders a source's keys its own way). */
const same = (a: unknown, b: unknown): boolean =>
  plain(a) && plain(b)
    ? Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => k in b && same(a[k], b[k]))
    : Array.isArray(a) && Array.isArray(b)
      ? a.length === b.length && a.every((v, i) => same(v, b[i]))
      : a === b;

const plain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
