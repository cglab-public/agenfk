/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThemeProvider, useTheme } from '../ThemeContext';

// Mock window.matchMedia (jsdom does not implement it by default).
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

const getRootClasses = () => window.document.documentElement.classList;
const getRootThemeAttr = () => window.document.documentElement.getAttribute('data-theme');

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset <html> state between tests.
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    root.removeAttribute('data-theme');
  });

  afterEach(() => {
    cleanup();
  });

  it('provides the light theme by default when the OS prefers light', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    expect(screen.getByText(/Current theme: light/i)).toBeDefined();
  });

  it('applies the .light class and data-theme="light" to <html>', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    expect(getRootClasses().contains('light')).toBe(true);
    expect(getRootThemeAttr()).toBe('light');
  });

  it('toggles from light to dark and persists to localStorage', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.getByText(/Current theme: dark/i)).toBeDefined();
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('applies the .dark class and data-theme="dark" to <html> after toggle', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByText('Toggle'));
    expect(getRootClasses().contains('dark')).toBe(true);
    expect(getRootClasses().contains('light')).toBe(false);
    expect(getRootThemeAttr()).toBe('dark');
  });

  it('initializes with the dark theme from localStorage', () => {
    localStorage.setItem('theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    expect(screen.getByText(/Current theme: dark/i)).toBeDefined();
    expect(getRootClasses().contains('dark')).toBe(true);
  });

  it('toggles from dark back to light', () => {
    localStorage.setItem('theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByText('Toggle'));
    expect(screen.getByText(/Current theme: light/i)).toBeDefined();
    expect(localStorage.getItem('theme')).toBe('light');
    expect(getRootClasses().contains('light')).toBe(true);
    expect(getRootThemeAttr()).toBe('light');
  });

  it('provides the dark theme when the OS prefers dark and no preference is stored', () => {
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementationOnce((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    expect(screen.getByText(/Current theme: dark/i)).toBeDefined();
    expect(getRootThemeAttr()).toBe('dark');
  });

  it('useTheme throws when used outside a ThemeProvider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ThrowTest = () => {
      useTheme(); // should throw
      return null;
    };
    expect(() => render(<ThrowTest />)).toThrow('useTheme must be used within a ThemeProvider');
    consoleError.mockRestore();
  });
});
