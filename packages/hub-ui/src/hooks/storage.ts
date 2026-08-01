/**
 * Minimal subset of the Web Storage API used by hooks that need
 * localStorage persistence.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Safely access window.localStorage, returning null in SSR or when unavailable.
 */
export function getLocalStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}