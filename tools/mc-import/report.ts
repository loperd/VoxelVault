import { ASPECTS, type ImportReport, type Result } from './import.ts';

/** The import report for people: totals, then every state that is not exact, with its findings. */
export function reportMarkdown(r: ImportReport, title: string): string {
  const pct = (n: number, of: number) => `${of ? ((100 * n) / of).toFixed(1) : '0.0'} %`;
  const states = r.states.length,
    order: Result[] = ['exact', 'unverified', 'approximated', 'unsupported'];
  const aspectOf = (f: { aspect?: string }) =>
    f.aspect === 'shape' ? 'geometry' : f.aspect === 'block-entity' ? 'state' : (f.aspect ?? '—');
  const byCode = new Map<
    string,
    { kind: string; aspect: string; code: string; states: number; cells: number; detail: string }
  >();
  for (const s of r.states)
    for (const f of s.findings) {
      const k = `${f.kind}:${f.code}`,
        e = byCode.get(k) ?? {
          kind: f.kind,
          aspect: aspectOf(f as { aspect?: string }),
          code: f.code,
          states: 0,
          cells: 0,
          detail: f.detail,
        };
      e.states++;
      e.cells += s.cells;
      byCode.set(k, e);
    }
  const blocks = new Map<string, { cells: number; states: number; result: Result }>();
  for (const s of r.states) {
    const name = s.state.replace(/\[.*$/, ''),
      b = blocks.get(name) ?? { cells: 0, states: 0, result: 'exact' as Result };
    b.cells += s.cells;
    b.states++;
    if (order.indexOf(s.result) > order.indexOf(b.result)) b.result = s.result;
    blocks.set(name, b);
  }
  const lines = [
    `# ${title}: import report`,
    '',
    `Sponge schematic v${r.source.sponge}${r.source.dataVersion ? `, data version ${r.source.dataVersion}` : ''}, ${r.source.size.join(' × ')} cells: ${r.cells.blocks} blocks, ${r.cells.air} air. Tiles from ${r.resources}.`,
    ...(r.region
      ? [
          `Region ${r.region.from.join(',')} – ${r.region.to.join(',')} only: ${r.region.left} cells of the schematic left out.`,
        ]
      : []),
    `Pack: ${r.blocks} blocks, ${r.textures.length} tiles. Made by the importer, not the author: ${r.scene.made.join(', ') || 'nothing'}.`,
    `Checked against: ${!r.reference ? 'nothing — no blockstates or models, so no state can be shown exact' : r.reference.compared ? `${r.reference.name}, Minecraft ${r.reference.minecraft} (data version ${r.reference.dataVersion})` : `nothing — ${r.reference.why}`}.`,
    '',
    '## By aspect',
    '',
    '| Aspect | ' + order.map((k) => `${k} states | ${k} cells`).join(' | ') + ' |',
    '|---|' + order.map(() => '---|---|').join(''),
    ...ASPECTS.map(
      (a) =>
        `| ${a} | ${order.map((k) => `${r.aspects[a][k].states} | ${r.aspects[a][k].cells} (${pct(r.aspects[a][k].cells, r.cells.blocks)})`).join(' | ')} |`,
    ),
    '',
    "`geometry`: the boxes and faces of the game's model. `material`: on every face the tile the game's model names, turned and cut the same (the same tile coordinates at the same corners), the same tint, drawn the same way (animation, translucency, judged by the reference's tile). `texture`: the pixels of every tile drawn are the reference's tile of that name, and how other tiles are drawn; other tiles are a choice, not a fault of the shape, and change nothing but this aspect. `state`: every property either drawn or not read by the game's blockstate; the water of a waterlogged cell; a block entity's data.",
    '',
    "`exact`: shown equal by the comparison. `unverified`: nothing to compare with says either way. `approximated`: drawn, with a named loss. `unsupported`: not drawn (or the mapping's placeholder).",
    '',
    '## Overall (the worst aspect)',
    '',
    '| Result | States | Share of states | Cells | Share of cells |',
    '|---|---|---|---|---|',
    ...order.map(
      (k) =>
        `| ${k} | ${r.totals[k].states} | ${pct(r.totals[k].states, states)} | ${r.totals[k].cells} | ${pct(r.totals[k].cells, r.cells.blocks)} |`,
    ),
    '',
    '## Losses by kind',
    '',
    '| Kind | Aspect | Code | States | Cells | Example |',
    '|---|---|---|---|---|---|',
    ...[...byCode.values()]
      .sort((a, b) => b.cells - a.cells)
      .map(
        (e) => `| ${e.kind} | ${e.aspect} | ${e.code} | ${e.states} | ${e.cells} | ${e.detail} |`,
      ),
    '',
    '## Blocks',
    '',
    '| Block | Result (worst state) | States | Cells |',
    '|---|---|---|---|',
    ...[...blocks]
      .sort((a, b) => b[1].cells - a[1].cells)
      .map(([n, b]) => `| ${n} | ${b.result} | ${b.states} | ${b.cells} |`),
    '',
    '## States that are not exact',
    '',
    '| State | Cells | Geometry | Material | Texture | State | Findings | Unverified |',
    '|---|---|---|---|---|---|---|---|',
    ...r.states
      .filter((s) => s.result !== 'exact')
      .map(
        (s) =>
          `| \`${s.state}\` | ${s.cells} | ${s.fidelity.geometry} | ${s.fidelity.material} | ${s.fidelity.texture} | ${s.fidelity.state} | ${s.findings.map((f) => `${f.code}: ${f.detail}`).join('; ')} | ${Object.entries(
            s.unverified,
          )
            .map(([a, w]) => `${a}: ${w.join('; ')}`)
            .join(' · ')} |`,
      ),
    '',
    `Block entities (data not imported): ${
      Object.entries(r.blockEntities)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }${r.strayBlockEntities ? `; ${r.strayBlockEntities} without a place in the schematic, not imported` : ''}. Entities (not imported): ${
      Object.entries(r.entities)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }.`,
    '',
  ];
  return lines.join('\n');
}
