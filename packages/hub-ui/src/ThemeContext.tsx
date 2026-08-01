import React, { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/**
 * Safely access `window.localStorage`.
 * Returns `null` when running outside a browser or when the storage access
 * throws (Safari private mode, "block all cookies" policies, quota exceeded).
 */
function getLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Resolve the initial theme: localStorage → OS preference → light. */
function resolveInitialTheme(): Theme {
  const storage = getLocalStorage();
  let saved: string | null = null;
  if (storage) {
    try {
      saved = storage.getItem('theme');
    } catch {
      // getItem can throw under strict cookie-block policies.
    }
  }
  if (saved === 'light' || saved === 'dark') return saved;

  // Fall back to OS preference; default to 'light' if matchMedia is
  // unavailable (older / embedded webviews).
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<Theme>(resolveInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    root.setAttribute('data-theme', theme);

    // Persist best-effort — swallow failures (quota exceeded, private mode).
    const storage = getLocalStorage();
    if (storage) {
      try {
        storage.setItem('theme', theme);
      } catch {
        // Storage write failed — theme still applies for the session.
      }
    }
  }, [theme]);

  const toggleTheme = () => {
    setThemeState(prev => (prev === 'light' ? 'dark' : 'light'));
  };

  const setTheme = (next: Theme) => {
    setThemeState(next);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};