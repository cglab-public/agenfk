import { useEffect, useState } from 'react';
import { getLocalStorage, StorageLike } from './storage';

/**
 * Resolve the initial theme from persisted storage, falling back to the
 * user OS preference.  Only exact `'light'` or `'dark'` values are accepted
 * from storage; anything else (or missing keys) falls through to
 * `prefersDark`.
 */
export function resolveInitialTheme(
  storage: StorageLike | null,
  prefersDark: boolean,
): 'light' | 'dark' {
  if (!storage) return prefersDark ? 'dark' : 'light';
  try {
    const stored = storage.getItem('theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // storage.getItem threw — fall through to OS preference
  }
  return prefersDark ? 'dark' : 'light';
}

/**
 * Apply the theme class and data-theme attribute to the <html> element.
 * Guarded for SSR (no-op when `document` is undefined).
 */
export function applyThemeToDocument(theme: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
  root.setAttribute('data-theme', theme);
}

/**
 * Hook that tracks and persists the UI theme ('light' | 'dark').
 *
 * Applies the theme class and data-theme attribute to <html> on every change
 * and persists the value to localStorage.
 */
export function useTheme(): { theme: 'light' | 'dark'; toggleTheme: () => void } {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    let prefersDark = false;
    if (typeof window !== 'undefined') {
      try {
        prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      } catch {
        // matchMedia not available — default to false
      }
    }
    return resolveInitialTheme(getLocalStorage(), prefersDark);
  });

  useEffect(() => {
    applyThemeToDocument(theme);

    const storage = getLocalStorage();
    if (storage) {
      try {
        storage.setItem('theme', theme);
      } catch {
        // Quota exceeded / private mode — drop silently
      }
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  return { theme, toggleTheme };
}