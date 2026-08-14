/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThemeProvider, useTheme } from '../ThemeContext';

// ---------------------------------------------------------------------------
// Mock window.matchMedia (default: system does NOT prefer dark)
// ---------------------------------------------------------------------------
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
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

// ---------------------------------------------------------------------------
// Helper component that exposes theme state + toggle in the DOM
// ---------------------------------------------------------------------------
const ThemeTester: React.FC = () => {
  const { theme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme-label">Current theme: {theme}</span>
      <button onClick={toggleTheme} aria-label="Toggle theme">
        Toggle
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('should provide default theme of light', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme-label')).toHaveTextContent(/light/i);
  });

  it('should toggle from light to dark and persist to localStorage', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: /toggle theme/i }));
    expect(screen.getByTestId('theme-label')).toHaveTextContent(/dark/i);
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('should initialize with dark theme from localStorage', () => {
    localStorage.setItem('theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme-label')).toHaveTextContent(/dark/i);
  });

  it('should default to dark when system prefers dark and no localStorage value', () => {
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
      })
    );
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme-label')).toHaveTextContent(/dark/i);
  });

  it('should toggle from dark back to light and persist', () => {
    localStorage.setItem('theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: /toggle theme/i }));
    expect(screen.getByTestId('theme-label')).toHaveTextContent(/light/i);
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('useTheme should throw when used outside ThemeProvider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const ThrowTest: React.FC = () => {
      useTheme();
      return null;
    };

    expect(() => render(<ThrowTest />)).toThrow(
      'useTheme must be used within a ThemeProvider'
    );
    consoleError.mockRestore();
  });

  it('applies class "dark" and data-theme="dark" to <html> after toggling to dark', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: /toggle theme/i }));
    const html = document.documentElement;
    expect(html.classList.contains('dark')).toBe(true);
    expect(html.getAttribute('data-theme')).toBe('dark');
  });

  it('applies class "light" and data-theme="light" to <html> for light theme', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    const html = document.documentElement;
    expect(html.classList.contains('light')).toBe(true);
    expect(html.getAttribute('data-theme')).toBe('light');
  });
});
