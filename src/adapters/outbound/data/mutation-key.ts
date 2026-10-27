/** Retain the key after an uncertain reply; a retry of the same intent must not spend twice. */
export class MutationKeys {
  private readonly keys = new Map<string, string>();
  for(intent: string): string {
    let key = this.keys.get(intent);
    if (!key) {
      key =
        typeof globalThis.crypto.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : [...globalThis.crypto.getRandomValues(new Uint8Array(16))]
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('');
      this.keys.set(intent, key);
    }
    return key;
  }
  done(intent: string): void {
    this.keys.delete(intent);
  }
}
