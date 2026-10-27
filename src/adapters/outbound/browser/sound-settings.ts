const KEY = 'voxel-vault:sound-muted';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Browser preference; no dependency on roulette state or a particular chest. */
export class SoundSettings {
  private muted = false;
  private readonly storage: () => PreferenceStorage | undefined;
  private readonly apply: (muted: boolean) => void;
  private readonly unlock: () => void;
  constructor(
    storage: () => PreferenceStorage | undefined,
    apply: (muted: boolean) => void,
    unlock: () => void = () => {},
  ) {
    this.storage = storage;
    this.apply = apply;
    this.unlock = unlock;
    try {
      this.muted = storage()?.getItem(KEY) === 'true';
    } catch {
      /* Storage may be unavailable. */
    }
    apply(this.muted);
  }
  isMuted(): boolean {
    return this.muted;
  }
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.apply(muted);
    if (!muted) this.unlock();
    try {
      this.storage()?.setItem(KEY, String(muted));
    } catch {
      /* Keep the in-memory preference. */
    }
  }
}
