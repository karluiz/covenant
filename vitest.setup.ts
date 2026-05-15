// jsdom in this project ships an empty `localStorage` object (no methods).
// Polyfill an in-memory Storage so tests that depend on localStorage work.
const store = new Map<string, string>();
const polyfill: Storage = {
  get length() { return store.size; },
  clear() { store.clear(); },
  getItem(k) { return store.has(k) ? store.get(k)! : null; },
  key(i) { return Array.from(store.keys())[i] ?? null; },
  removeItem(k) { store.delete(k); },
  setItem(k, v) { store.set(k, String(v)); },
};
Object.defineProperty(globalThis, "localStorage", {
  value: polyfill,
  writable: true,
  configurable: true,
});
