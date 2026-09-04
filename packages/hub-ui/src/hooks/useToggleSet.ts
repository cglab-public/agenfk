import { useEffect, useRef, useState } from 'react';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Read a persisted Set<string> from a Storage-like object.
 *
 * Critical contract: an explicitly-stored empty array round-trips as an
 * empty Set — it must NOT silently fall back to `fallback`. That means a
 * user who clears all chips and refreshes still sees no chips selected
 * (instead of the page's defaults popping back).
 *
 * `fallback` only applies when the key is missing or the stored value is
 * unparseable.
 */
export function readPersistedSet(
  storage: StorageLike | null | undefined,
  key: string,
  fallback: Iterable<string>,
): Set<string> {
  if (!storage) return new Set(fallback);
  const raw = storage.getItem(key);
  if (raw === null) return new Set(fallback);
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(fallback);
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set(fallback);
  }
}

export function writePersistedSet(
  storage: StorageLike | null | undefined,
  key: string,
  value: Set<string>,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify([...value]));
  } catch {
    // Quota exceeded / private mode — drop silently; UX is fine without persistence.
  }
}

function getLocalStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

interface ToggleSetOptions {
  storageKey?: string;
}

export function useToggleSet(initial: Iterable<string> = [], opts: ToggleSetOptions = {}) {
  const { storageKey } = opts;
  const storage = useRef<StorageLike | null>(getLocalStorage()).current;

  const [s, setS] = useState<Set<string>>(() =>
    storageKey ? readPersistedSet(storage, storageKey, initial) : new Set(initial),
  );

  useEffect(() => {
    if (storageKey) writePersistedSet(storage, storageKey, s);
  }, [s, storage, storageKey]);

  return {
    set: s,
    toggle: (v: string) => setS(prev => { const n = new Set(prev); n.has(v) ? n.delete(v) : n.add(v); return n; }),
    // Bulk add without removing anything already selected — the model
    // meta-filter resolves a vendor/license choice to N model ids and must not
    // clobber models the user picked individually.
    addMany: (values: Iterable<string>) => setS(prev => {
      const n = new Set(prev);
      for (const v of values) n.add(v);
      return n;
    }),
    clear: () => setS(new Set()),
  };
}
