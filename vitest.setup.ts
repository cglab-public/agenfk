/**
 * Restore `localStorage` for jsdom test environments.
 *
 * Node 26 ships its own global `localStorage`, which is `undefined` unless the
 * process was started with `--localstorage-file`. When Vitest installs the
 * jsdom globals it copies that undefined value onto the jsdom window as an OWN
 * property, clobbering jsdom's real `localStorage` getter — while
 * `sessionStorage` survives, because Node defines no such global. The symptom
 * is `TypeError: Cannot read properties of undefined` on any `localStorage`
 * access from a spec that correctly declares `@vitest-environment jsdom`.
 *
 * Fixing it here rather than in application code keeps the workaround at the
 * layer that actually broke: components are right to use the standard global.
 * No-op under the default `node` environment, where there is no window.
 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    // Storage coerces keys to strings and returns null (not undefined) for misses.
    return this.map.has(String(key)) ? this.map.get(String(key))! : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.map.delete(String(key));
  }

  clear(): void {
    this.map.clear();
  }
}

if (typeof window !== 'undefined' && typeof (window as Window & { localStorage?: unknown }).localStorage === 'undefined') {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: false });
  // Specs and components reach it either way; keep the two views identical.
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: false });
}
