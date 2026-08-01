import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

/**
 * Hub UI theme state.
 *
 * Deliberately mirrors packages/ui/src/ThemeContext.tsx (two-state light/dark,
 * localStorage-persisted under the same 'theme' key, seeded from the OS
 * preference) so the two independently-built Vite apps behave identically.
 *
 * The design tokens themselves already support this: packages/brand/tokens.css
 * ships `.dark`/`[data-theme="dark"]` and `.light`/`[data-theme="light"]`
 * blocks. This provider's job is only to put the right marker on <html>; the
 * `@variant dark` line in index.css then routes hub-ui's ~132 `dark:`
 * utilities through the same marker.
 */

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'theme';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function prefersDark(): boolean {
  // matchMedia is absent in some jsdom/SSR contexts — treat that as "no
  // preference" rather than crashing the whole app on boot.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    // Anything other than the two known values is treated as absent, so a
    // corrupt entry degrades to the OS preference instead of a broken theme.
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    // Private-mode / blocked storage.
    return null;
  }
}

function resolveInitialTheme(): Theme {
  return readStoredTheme() ?? (prefersDark() ? 'dark' : 'light');
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setTheme] = useState<Theme>(resolveInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    // Remove both before adding one so the two never coexist — tokens.css
    // gives .dark and .light equal specificity, so source order would decide
    // and the result would be effectively random.
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    root.setAttribute('data-theme', theme);
    // Drive color-scheme from the explicit choice so native form controls,
    // scrollbars and autofill match. A static `light dark` in CSS would keep
    // those widgets following the OS and contradict the user's selection.
    root.style.colorScheme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Persistence is best-effort; an in-session theme still works.
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
