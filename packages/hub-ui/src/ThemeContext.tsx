import React, { createContext, useContext, useRef, useState, useCallback, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/** Apply theme class + data-theme + localStorage. */
function applyTheme(theme: Theme) {
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
  // Mutable ref holds the live theme value — updated synchronously by toggleTheme.
  const themeRef = useRef<Theme>(resolveInitialTheme());
  const [, forceUpdate] = useState({});

  // Apply the initial theme on mount.
  useLayoutEffect(() => {
    applyTheme(themeRef.current);
  }, []);

  const toggleTheme = useCallback(() => {
    themeRef.current = themeRef.current === 'light' ? 'dark' : 'light';
    applyTheme(themeRef.current);
    flushSync(() => {
      forceUpdate({});
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme: themeRef.current, toggleTheme }}>
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
