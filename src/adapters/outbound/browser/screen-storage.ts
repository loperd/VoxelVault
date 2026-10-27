type BrowserStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Versioned UI snapshots; denied storage or damaged data never prevents navigation. */
export class ScreenStorage {
  private readonly storage: () => BrowserStorage | undefined;
  constructor(storage: () => BrowserStorage | undefined) {
    this.storage = storage;
  }
  read<T>(key: string, decode: (value: unknown) => T): T | undefined {
    try {
      const raw = this.storage()?.getItem(`voxel-vault:${key}`);
      if (!raw || raw.length > 2_000_000) return;
      const saved: unknown = JSON.parse(raw);
      if (
        !saved ||
        typeof saved !== 'object' ||
        !('version' in saved) ||
        saved.version !== 1 ||
        !('value' in saved)
      )
        return;
      return decode(saved.value);
    } catch {
      return;
    }
  }
  write(key: string, value: unknown): void {
    try {
      this.storage()?.setItem(`voxel-vault:${key}`, JSON.stringify({ version: 1, value }));
    } catch {
      /* Optional browser persistence. */
    }
  }
  remove(key: string): void {
    try {
      this.storage()?.removeItem(`voxel-vault:${key}`);
    } catch {
      /* Optional browser persistence. */
    }
  }
}
