/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../ThemeContext';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

// ── mock window.matchMedia ──────────────────────────────────────
const defaultMatchMedia = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
});

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => defaultMatchMedia(query)),
});

// ── test harness component ──────────────────────────────────────
const ThemeTester: React.FC = () => {
  const { theme, toggleTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="current-theme">{theme}</span>
      <button data-testid="toggle-btn" onClick={toggleTheme}>
        Toggle
      </button>
      <button data-testid="set-dark-btn" onClick={() => setTheme('dark')}>
        Set Dark
      </button>
      <button data-testid="set-light-btn" onClick={() => setTheme('light')}>
        Set Light
      </button>
    </div>
  );
};

// ── tests ───────────────────────────────────────────────────────
describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
    // Reset matchMedia mock to default (no dark preference)
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation(
      query => defaultMatchMedia(query),
    );
  });

  afterEach(() => {
    cleanup();
  });

  // ── initialisation ────────────────────────────────────────────

  it('provides default "light" theme when no localStorage and no OS preference', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    expect(screen.getByTestId('current-theme').textContent).toBe('light');
  });

  it('initialises with "dark" from localStorage', () => {
    localStorage.setItem('theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    expect(screen.getByTestId('current-theme').textContent).toBe('dark');
  });

  it('initialises with "light" from localStorage', () => {
    localStorage.setItem('theme', 'light');
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    expect(screen.getByTestId('current-theme').textContent).toBe('light');
  });

  it('ignores invalid persisted value and falls back to OS preference (light)', () => {
    localStorage.setItem('theme', 'banana');
    // matchMedia mock defaults to matches: false → light
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    expect(screen.getByTestId('current-theme').textContent).toBe('light');
  });

  it('ignores invalid persisted value and falls back to OS preference (dark)', () => {
    localStorage.setItem('theme', 'banana');
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementationOnce(
      query => ({
        ...defaultMatchMedia(query),
        matches: query === '(prefers-color-scheme: dark)',
      }),
    );
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    expect(screen.getByTestId('current-theme').textContent).toBe('dark');
  });

  it('initialises to "dark" when system prefers dark and no localStorage', () => {
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementationOnce(
      query => ({
        ...defaultMatchMedia(query),
        matches: query === '(prefers-color-scheme: dark)',
      }),
    );
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    expect(screen.getByTestId('current-theme').textContent).toBe('dark');
  });

  // ── toggleTheme ───────────────────────────────────────────────

  it('toggles light → dark and persists to localStorage', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByTestId('toggle-btn'));
    expect(screen.getByTestId('current-theme').textContent).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('toggles dark → light and persists to localStorage', () => {
    localStorage.setItem('theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByTestId('toggle-btn'));
    expect(screen.getByTestId('current-theme').textContent).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
  });

  // ── setTheme ──────────────────────────────────────────────────

  it('setTheme("dark") sets the theme explicitly and persists it', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByTestId('set-dark-btn'));
    expect(screen.getByTestId('current-theme').textContent).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('setTheme("light") sets the theme explicitly and persists it', () => {
    localStorage.setItem('theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByTestId('set-light-btn'));
    expect(screen.getByTestId('current-theme').textContent).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
  });

  // ── document.documentElement side-effects ─────────────────────

  it('applies theme class and data-theme attribute on render', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    const root = document.documentElement;
    expect(root.classList.contains('light')).toBe(true);
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('updates document.documentElement class and data-theme after toggle', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByTestId('toggle-btn'));
    const root = document.documentElement;
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.classList.contains('light')).toBe(false);
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('updates document.documentElement class and data-theme after setTheme', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByTestId('set-dark-btn'));
    const root = document.documentElement;
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.classList.contains('light')).toBe(false);
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  // ── useTheme outside provider ─────────────────────────────────

  it('useTheme throws when used outside ThemeProvider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ThrowTest: React.FC = () => {
      useTheme();
      return null;
    };
    expect(() => render(<ThrowTest />)).toThrow(
      'useTheme must be used within a ThemeProvider',
    );
    consoleError.mockRestore();
  });

  // ── defect #1 — guarded localStorage / matchMedia ─────────────

  it('falls back to OS preference when localStorage.getItem throws', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Access denied', 'SecurityError');
    });
    // Pretend the OS prefers dark so we can confirm the fallback path.
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementationOnce(
      query => ({
        ...defaultMatchMedia(query),
        matches: query === '(prefers-color-scheme: dark)',
      }),
    );
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('current-theme').textContent).toBe('dark');
    getItemSpy.mockRestore();
  });

  it('toggleTheme works when localStorage.setItem throws', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>,
    );
    // Start in light (no stored value, matchMedia defaults to false).
    expect(screen.getByTestId('current-theme').textContent).toBe('light');

    // Toggle to dark — must succeed even though setItem throws.
    fireEvent.click(screen.getByTestId('toggle-btn'));
    expect(screen.getByTestId('current-theme').textContent).toBe('dark');

    // DOM side-effects still applied.
    const root = document.documentElement;
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.getAttribute('data-theme')).toBe('dark');

    setItemSpy.mockRestore();
  });
});