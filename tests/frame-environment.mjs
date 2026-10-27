export function frameEnvironment() {
  const frames = new Map(),
    listeners = new Set();
  let sequence = 0,
    hidden = false;
  return {
    frames,
    listeners,
    requestFrame(callback) {
      frames.set(++sequence, callback);
      return sequence;
    },
    cancelFrame(id) {
      frames.delete(id);
    },
    isHidden: () => hidden,
    onVisibilityChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    visibility(value) {
      hidden = value;
      for (const listener of listeners) listener();
    },
    tick(time) {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(time);
    },
  };
}
