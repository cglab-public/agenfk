/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveInitialTheme } from '../hooks/useTheme';
import { ThemeToggle } from '../components/ThemeToggle';

function makeStorage(entries: Record<string, string>) {
  return {
    getItem(key: string) {
      return entries[key] ?? null;
    },
    setItem(key: string, value: string) {
      entries[key] = value;
    },
  };
}

describe('resolveInitialTheme', () => {
  it('returns "dark" when storage has theme="dark", prefersDark=false', () => {
    expect(resolveInitialTheme(makeStorage({ theme: 'dark' }), false)).toBe('dark');
  });

  it('returns "light" when storage has theme="light", prefersDark=true', () => {
    expect(resolveInitialTheme(makeStorage({ theme: 'light' }), true)).toBe('light');
  });

  it('returns "dark" when storage empty and prefersDark=true', () => {
    expect(resolveInitialTheme(makeStorage({}), true)).toBe('dark');
  });

  it('returns "light" when storage empty and prefersDark=false', () => {
    expect(resolveInitialTheme(makeStorage({}), false)).toBe('light');
  });

  it('ignores stored value "blue" (not exactly "light"/"dark"), falls back to prefersDark', () => {
    expect(resolveInitialTheme(makeStorage({ theme: 'blue' }), true)).toBe('dark');
    expect(resolveInitialTheme(makeStorage({ theme: 'blue' }), false)).toBe('light');
  });

  it('tolerates storage === null, falls back to prefersDark', () => {
    expect(resolveInitialTheme(null, true)).toBe('dark');
    expect(resolveInitialTheme(null, false)).toBe('light');
  });
});

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a button with data-testid="theme-toggle"', () => {
    render(<ThemeToggle />);
    expect(screen.getByTestId('theme-toggle')).toBeDefined();
  });

  it('clicking toggles to dark mode', () => {
    render(<ThemeToggle />);
    const btn = screen.getByTestId('theme-toggle');
    fireEvent.click(btn);

    expect(document.documentElement.className).toContain('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('clicking twice returns to light mode', () => {
    render(<ThemeToggle />);
    const btn = screen.getByTestId('theme-toggle');
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(document.documentElement.className).toContain('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('renders dark when localStorage theme is pre-seeded to "dark"', () => {
    localStorage.setItem('theme', 'dark');
    render(<ThemeToggle />);

    expect(document.documentElement.className).toContain('dark');
  });
});