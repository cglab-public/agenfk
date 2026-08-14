import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { flushSync } from 'react-dom';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/** Apply theme class + data-theme + localStorage to the document. */
function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
  root.setAttribute('data-theme', theme);
  localStorage.setItem('hub-theme', theme);
}

/** Resolve the initial theme from localStorage or system preference. */
function resolveInitialTheme(): Theme {
  const saved = localStorage.getItem('hub-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setTheme] = useState<Theme>(resolveInitialTheme);

  // Apply on mount and after every theme change.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // flushSync ensures the re-render is synchronous so consumers (and tests) see
  // the updated value immediately after calling toggleTheme.
  const toggleTheme = useCallback(() => {
    flushSync(() => {
      setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
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
