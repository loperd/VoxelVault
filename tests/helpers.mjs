export function item(id, displayWeight = 0, overrides = {}) {
  return {
    id: String(id),
    title: `Item ${id}`,
    image: `/items/${id}.png`,
    rarity: 'common',
    displayWeight,
    ...overrides,
  };
}

// The legacy catalog's exact percentages. Round(40 * weight / 100) totals 39.
export function legacyCatalog() {
  const names = [
    'Vip',
    'Premium',
    'Creative',
    'Admin',
    'Lord',
    'Enigma',
    'Deluxe',
    'Caesar',
    'Baron',
    'Hero',
    'Sentinel',
    'Emperor',
    'Ruler',
    'King',
  ];
  return [25, 15, 10, 7, 7, 6, 5, 5, 5, 5, 3, 3, 3, 1].map((weight, index) =>
    item(index + 1, weight, {
      title: names[index],
      rarity: index < 7 ? 'common' : index < 12 ? 'rare' : 'legendary',
    }),
  );
}

export const constantRandom = (value = 0.5) => ({ next: () => value });

export function seededRandom(seed) {
  let state = seed >>> 0;
  return {
    next() {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    },
  };
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A stand-in for the server's inventory API (GET /api/v1/inventory, POST …/claim|open) holding
 * chest DTOs as the server sends them. `outcomes` maps a session to what the server decides for
 * it: an item DTO (the drop) or { destroyed: 'impact' | 'opening' }.
 */
export function inventoryServer(chests, outcomes = {}) {
  const rows = new Map(
    chests.map((chest) => [
      chest.id,
      { status: 'available', seed: 1, contents: [], traits: [], condition: 1, ...chest },
    ]),
  );
  const json = (value) => ({ ok: true, status: 200, json: async () => structuredClone(value) });
  const conflict = { ok: false, status: 409, json: async () => ({}) };
  const requests = [];
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname.replace(/^.*\/api\/v1\/inventory/, '');
    if (path === '/merge') return merge(new URL(url), init);
    if (!init.method || init.method === 'GET') return json([...rows.values()]);
    const [, id, action] = path.split('/'),
      row = rows.get(decodeURIComponent(id)),
      body = JSON.parse(init.body);
    requests.push([action, decodeURIComponent(id), body.sessionId]);
    if (!row) return { ok: false, status: 404, json: async () => ({}) };
    const outcome = outcomes[body.sessionId] ?? {
      id: 'p1',
      title: 'Prize',
      image: '/p.png',
      type: 'rare',
      chance: 1,
    };
    if (action === 'claim') {
      if (row.sessionId === body.sessionId && row.status !== 'available')
        return json({ chest: row, landing: null });
      if (row.status !== 'available') return conflict;
      Object.assign(row, { status: 'opening', sessionId: body.sessionId });
      if (outcome.destroyed === 'impact')
        Object.assign(row, { status: 'destroyed', destroyedAt: 'impact' });
      return json({ chest: row, landing: { destroyed: outcome.destroyed === 'impact' } });
    }
    if (action === 'open') {
      if (row.sessionId !== body.sessionId) return conflict;
      if (row.status === 'opening') {
        if (outcome.destroyed)
          Object.assign(row, { status: 'destroyed', destroyedAt: outcome.destroyed });
        else
          Object.assign(row, {
            status: 'opened',
            drop: { item: outcome, state: 'intact' },
            openedAt: new Date(0).toISOString(),
          });
      }
      return json({
        chest: row,
        item: row.drop
          ? { id: `item-${id}`, item: row.drop.item, state: row.drop.state, origin: id }
          : null,
      });
    }
    return conflict;
  };
  // Merge: odds for a pair, then the pair spent into a new chest; one of a pair that is not two
  // available chests of one type is refused.
  let merges = 0;
  const merge = (url, init) => {
    const { a, b } =
      init.method === 'POST' ? JSON.parse(init.body) : Object.fromEntries(url.searchParams);
    requests.push([init.method === 'POST' ? 'merge' : 'odds', a, b]);
    const first = rows.get(a),
      second = rows.get(b);
    if (!first || !second) return { ok: false, status: 404, json: async () => ({}) };
    if (
      a === b ||
      first.caseId !== second.caseId ||
      first.status !== 'available' ||
      second.status !== 'available'
    )
      return conflict;
    if (init.method !== 'POST')
      return json({
        traits: [...first.traits, ...second.traits].map((trait) => ({
          id: trait.id,
          keep: trait.id.includes('cracks') ? 0 : 40,
          upgrade: 0,
        })),
        contents: { total: 12, kept: 8, keep: 66.67 },
      });
    first.status = second.status = 'merged';
    rows.delete(a);
    rows.delete(b);
    const chest = {
      id: `merged-${++merges}`,
      caseId: first.caseId,
      status: 'available',
      seed: first.seed + second.seed,
      contents: [],
      traits: [],
      condition: 1,
      origin: { source: 'merge', parents: [a, b] },
    };
    rows.set(chest.id, chest);
    return { ok: true, status: 201, json: async () => structuredClone(chest) };
  };
  return { fetcher, rows, requests };
}

/** A server inventory for the given chest DTOs, read once, ready to use. */
export async function loadedInventory(chests, outcomes) {
  const { ApiInventory } = await import('../src/adapters/outbound/data/api-inventory.ts');
  const { CASES } = await import('../src/config/cases.ts');
  const server = inventoryServer(chests, outcomes),
    errors = [];
  const inventory = new ApiInventory(
    'https://example.test/',
    CASES,
    (error) => errors.push(error),
    server.fetcher,
  );
  await inventory.load();
  return { inventory, server, errors };
}

/** Every case type stocked as the server would issue it: `count` chests each, varied seeds and traits. */
export function issuedStock(cases, count = 100) {
  const traits = (index) =>
    [
      index % 3 === 0 && { id: 'moss', intensity: 0.6, seed: index },
      index % 5 === 0 && { id: 'body-cracks', intensity: 0.4, seed: index },
    ].filter(Boolean);
  return cases.flatMap((definition) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${definition.id}-${index}`,
      caseId: definition.id,
      seed: (index * 2654435761) >>> 0,
      traits: traits(index),
    })),
  );
}
