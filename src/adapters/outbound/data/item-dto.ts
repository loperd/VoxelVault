import { copyCatalog, copyItem, type Item } from '../../../domain/item.ts';
import { resolvePublicAsset } from './asset-url.ts';
import { DataError } from './data-error.ts';

export function decodeItem(value: unknown, baseUrl: URL): Item {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DataError('INVALID_DTO', 'An item response must be an object.');
  }
  const dto = value as Record<string, unknown>;
  const validId =
    (typeof dto.id === 'string' && dto.id.trim().length > 0) ||
    (typeof dto.id === 'number' && Number.isSafeInteger(dto.id) && dto.id >= 0);
  const validChance =
    typeof dto.chance === 'number' ||
    (typeof dto.chance === 'string' &&
      /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(dto.chance.trim()));
  if (
    !validId ||
    !validChance ||
    typeof dto.title !== 'string' ||
    typeof dto.image !== 'string' ||
    typeof dto.type !== 'string'
  ) {
    throw new DataError('INVALID_DTO', 'An item response has invalid fields.');
  }
  // Domain validation also checks finite weights and the allowed rarity values.
  return copyItem({
    id: String(dto.id).trim(),
    title: dto.title.trim(),
    image: resolvePublicAsset(dto.image, baseUrl),
    rarity: dto.type as Item['rarity'],
    displayWeight: Number(dto.chance),
  });
}

export function decodeCatalog(value: unknown, baseUrl: URL): readonly Item[] {
  if (!Array.isArray(value)) {
    throw new DataError('INVALID_DTO', 'The catalog response must be an array.');
  }
  return copyCatalog(Array.from(value, (entry) => decodeItem(entry, baseUrl)));
}
