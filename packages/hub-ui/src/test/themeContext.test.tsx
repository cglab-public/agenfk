/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { ThemeProvider, useTheme } from '../ThemeContext';

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove('light', 'dark');
  document.documentElement.removeAttribute('data-theme');
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* Small harness that renders the current theme + a toggle button      */
/* ------------------------------------------------------------------ */
function Harness() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="current-theme">{theme}</span>
      <button data-testid="toggle" onClick={toggleTheme}>flip</button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
function stubMatchMedia(dark: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('dark') ? dark : !dark,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('ThemeProvider / useTheme', () => {
  /* ---- initial theme from localStorage ---- */

  it('starts dark when localStorage hub-theme is "dark"', () => {
    localStorage.setItem('hub-theme', 'dark');
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    );
    expect(screen.getByTestId('current-theme').textContent).toBe('dark');
  });

  it('starts light when localStorage hub-theme is "light"', () => {
    localStorage.setItem('hub-theme', 'light');
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    );
    expect(screen.getByTestId('current-theme').textContent).toBe('light');
  });

  /* ---- fallback to matchMedia ---- */

  it('falls back to dark when matchMedia prefers dark', () => {
    stubMatchMedia(true);
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    );
    expect(screen.getByTestId('current-theme').textContent).toBe('dark');
  });

  it('falls back to light when matchMedia prefers light', () => {
    stubMatchMedia(false);
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    );
    expect(screen.getByTestId('current-theme').textContent).toBe('light');
  });

  /* ---- class + data-theme on document.documentElement ---- */

  it('applies class "dark" and data-theme="dark" when theme is dark', () => {
    localStorage.setItem('hub-theme', 'dark');
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('applies class "light" and data-theme="light" when theme is light', () => {
    localStorage.setItem('hub-theme', 'light');
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    );
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  /* ---- toggleTheme ---- */

  it('toggleTheme flips light to dark, updates class/attribute and localStorage', () => {
    localStorage.setItem('hub-theme', 'light');
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    );
    screen.getByTestId('toggle').click();
    expect(screen.getByTestId('current-theme').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('hub-theme')).toBe('dark');
  });

  it('toggleTheme flips dark to light, updates class/attribute and localStorage', () => {
    localStorage.setItem('hub-theme', 'dark');
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    );
    screen.getByTestId('toggle').click();
    expect(screen.getByTestId('current-theme').textContent).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('hub-theme')).toBe('light');
  });

  /* ---- useTheme outside provider throws ---- */

  it('throws when useTheme() is called outside ThemeProvider', () => {
    expect(() => {
      render(<Harness />);
    }).toThrow('ThemeProvider');
  });
});
