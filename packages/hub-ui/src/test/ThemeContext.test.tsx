/**
 * @vitest-environment jsdom
 *
 * TASK 2bad809f — hub-ui ThemeContext provider.
 *
 * Mirrors packages/ui/src/ThemeContext.tsx behaviour (two-state light/dark,
 * localStorage-persisted, seeded from prefers-color-scheme) so the two Vite
 * apps cannot drift. Extra coverage here that packages/ui lacks: the DOM side
 * effects on <html> (class + data-theme + color-scheme), which are what the
 * 132 existing `dark:` utilities in hub-ui actually key off.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { ThemeProvider, useTheme } from '../ThemeContext';
import { mockPrefersColorScheme, resetThemeState } from './themeTestUtils';

const mockPrefersDark = mockPrefersColorScheme;

const ThemeTester = () => {
  const { theme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="current">{theme}</span>
      <button onClick={toggleTheme}>Toggle</button>
    </div>
  );
};

const renderTester = () =>
  render(
    <ThemeProvider>
      <ThemeTester />
    </ThemeProvider>
  );

describe('hub-ui ThemeContext', () => {
  beforeEach(() => {
    resetThemeState();
    mockPrefersDark(false);
  });

  afterEach(cleanup);

  describe('initial theme resolution', () => {
    it('defaults to light when the OS has no dark preference', () => {
      renderTester();
      expect(screen.getByTestId('current').textContent).toBe('light');
    });

    it('seeds from prefers-color-scheme: dark when nothing is persisted', () => {
      mockPrefersDark(true);
      renderTester();
      expect(screen.getByTestId('current').textContent).toBe('dark');
    });

    it('lets a persisted choice win over the OS preference', () => {
      // OS says dark, user previously forced light -> light must win.
      mockPrefersDark(true);
      localStorage.setItem('theme', 'light');
      renderTester();
      expect(screen.getByTestId('current').textContent).toBe('light');
    });

    it('restores a persisted dark choice on a light OS', () => {
      localStorage.setItem('theme', 'dark');
      renderTester();
      expect(screen.getByTestId('current').textContent).toBe('dark');
    });

    it('ignores a corrupt persisted value and falls back to the OS preference', () => {
      localStorage.setItem('theme', 'banana');
      mockPrefersDark(true);
      renderTester();
      expect(screen.getByTestId('current').textContent).toBe('dark');
    });

    it('survives a matchMedia-less environment without throwing', () => {
      // Older jsdom / SSR-ish contexts expose no matchMedia at all.
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: undefined,
      });
      expect(() => renderTester()).not.toThrow();
      expect(screen.getByTestId('current').textContent).toBe('light');
    });
  });

  describe('toggling', () => {
    it('flips light -> dark and persists it', () => {
      renderTester();
      fireEvent.click(screen.getByText('Toggle'));
      expect(screen.getByTestId('current').textContent).toBe('dark');
      expect(localStorage.getItem('theme')).toBe('dark');
    });

    it('flips dark -> light and persists it', () => {
      localStorage.setItem('theme', 'dark');
      renderTester();
      fireEvent.click(screen.getByText('Toggle'));
      expect(screen.getByTestId('current').textContent).toBe('light');
      expect(localStorage.getItem('theme')).toBe('light');
    });
  });

  describe('DOM side effects on <html>', () => {
    it('applies the light class and data-theme on mount', () => {
      renderTester();
      const root = document.documentElement;
      expect(root.classList.contains('light')).toBe(true);
      expect(root.classList.contains('dark')).toBe(false);
      expect(root.getAttribute('data-theme')).toBe('light');
    });

    it('swaps the class and data-theme when toggled, never keeping both', () => {
      renderTester();
      fireEvent.click(screen.getByText('Toggle'));
      const root = document.documentElement;
      expect(root.classList.contains('dark')).toBe(true);
      expect(root.classList.contains('light')).toBe(false);
      expect(root.getAttribute('data-theme')).toBe('dark');
    });

    it('drives color-scheme so native controls and scrollbars match', () => {
      // tokens.css hardcodes `color-scheme: light dark`, which leaves native
      // widgets following the OS even after an explicit override. TASK 85c7a519.
      renderTester();
      expect(document.documentElement.style.colorScheme).toBe('light');
      fireEvent.click(screen.getByText('Toggle'));
      expect(document.documentElement.style.colorScheme).toBe('dark');
    });

    it('does not clobber unrelated classes already on <html>', () => {
      document.documentElement.classList.add('some-vendor-class');
      renderTester();
      expect(document.documentElement.classList.contains('some-vendor-class')).toBe(true);
    });
  });

  it('throws a helpful error when useTheme is used outside the provider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Orphan = () => {
      useTheme();
      return null;
    };
    expect(() => render(<Orphan />)).toThrow('useTheme must be used within a ThemeProvider');
    consoleError.mockRestore();
  });
});
