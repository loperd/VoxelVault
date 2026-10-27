import { ENDER_CASE } from '../config/cases.ts';
import { ChestPreviewRenderer } from '../adapters/outbound/chest/chest-preview-renderer.ts';
import { changeChestAppearance, createChestAppearance } from '../domain/chest-appearance.ts';

/**
 * Development contact sheet: the real preview renderer with each catalogue entry at several
 * intensities. ?ids=moss,cobweb&levels=.3,.6,1&combo=1 (combo: all ids on one chest per level).
 * The finished sheet is exposed as window.modsSheet (JPEG data URL) for automated review.
 */
const params = new URLSearchParams(location.search);
const catalog = ENDER_CASE.model.modifications.catalog;
const ids = params.get('ids')?.split(',').filter(Boolean) ?? catalog.map((entry) => entry.id);
const levels = (params.get('levels') ?? '.35,.7,1').split(',').map(Number);
const rows: { label: string; modifications: { id: string; intensity: number }[] }[][] = params.get(
  'combo',
)
  ? [
      levels.map((level) => ({
        label: `${ids.join('+')} ${level}`,
        modifications: ids.map((id) => ({ id, intensity: level })),
      })),
    ]
  : ids.map((id) =>
      levels.map((level) => ({
        label: `${id} ${level}`,
        modifications: [{ id, intensity: level }],
      })),
    );
const status = document.getElementById('status')!;
const renderer = new ChestPreviewRenderer(document, new URL('.', document.baseURI));
const cell = { width: 640, height: 520 },
  scale = Number(params.get('scale') ?? 0.5);
const sheet = document.createElement('canvas');
sheet.width = cell.width * scale * levels.length;
sheet.height = (cell.height * scale + 22) * rows.length;
const context = sheet.getContext('2d')!;
context.fillStyle = '#1b2a2c';
context.fillRect(0, 0, sheet.width, sheet.height);
context.font = '14px system-ui';
context.fillStyle = '#e8eef0';
const signal = new AbortController().signal;
for (const [row, cells] of rows.entries()) {
  for (const [column, item] of cells.entries()) {
    const appearance = changeChestAppearance(createChestAppearance(4242), {
      modifications: item.modifications,
    });
    const canvas = await renderer.render(ENDER_CASE, appearance, signal);
    const x = column * cell.width * scale,
      y = row * (cell.height * scale + 22);
    context.fillText(item.label, x + 8, y + 16);
    context.drawImage(canvas, x, y + 22, cell.width * scale, cell.height * scale);
  }
}
document.body.append(sheet);
(window as unknown as { modsSheet: string }).modsSheet = sheet.toDataURL('image/jpeg', 0.9);
status.textContent = 'ready';
