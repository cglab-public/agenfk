/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThemeProvider, useTheme } from '../ThemeContext';

// Mock window.matchMedia (jsdom does not implement it). Defaults to a
// light system preference; individual tests override it as needed.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const ThemeTester = () => {
  const { theme, toggleTheme } = useTheme();
  return (
    <div>
      <span>Current theme: {theme}</span>
      <button onClick={toggleTheme}>Toggle</button>
    </div>
  );
};

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset <html> to a clean slate between tests.
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    cleanup();
  });

  it('defaults to light when no saved theme and system prefers light', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>,
    );
    expect(screen.getByText(/Current theme: light/i)).toBeDefined();
  });

  it('applies the light class and data-theme attribute to <html>', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('toggles from light to dark and persists the choice', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.getByText(/Current theme: dark/i)).toBeDefined();
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('initializes from a saved dark theme in localStorage', () => {
    localStorage.setItem('theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>,
    );
    expect(screen.getByText(/Current theme: dark/i)).toBeDefined();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('falls back to system preference when no saved theme', () => {
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (query: string) => ({
        matches: query === '(prefers-color-scheme: dark)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    );
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>,
    );
    expect(screen.getByText(/Current theme: dark/i)).toBeDefined();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggles from dark back to light', () => {
    localStorage.setItem('theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.getByText(/Current theme: light/i)).toBeDefined();
    expect(localStorage.getItem('theme')).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('throws when useTheme is used outside a ThemeProvider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ThrowTest = () => {
      useTheme();
      return null;
    };
    expect(() => render(<ThrowTest />)).toThrow(
      'useTheme must be used within a ThemeProvider',
    );
    consoleError.mockRestore();
  });
});
