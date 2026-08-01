/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { ThemeProvider, useTheme } from '../ThemeContext';

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove('light', 'dark');
  document.documentElement.removeAttribute('data-theme');
});

/** Helper component that exposes theme state for testing */
function TestToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme-value">{theme}</span>
      <button data-testid="toggle-btn" onClick={toggleTheme}>
        Toggle
      </button>
    </div>
  );
}

describe('ThemeToggle', () => {
  beforeEach(() => {
    // Default: no saved theme, clean matchMedia mock
  });

  it('defaults to light when no OS preference is set and no saved theme exists', () => {
    // matchMedia returns false for (prefers-color-scheme: dark)
    window.matchMedia = (() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as any;

    render(
      <ThemeProvider>
        <TestToggle />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme-value').textContent).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(localStorage.getItem('hub-theme')).toBe('light');
  });

  it('defaults to dark when OS prefers dark mode and no saved theme exists', () => {
    window.matchMedia = (() => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as any;

    render(
      <ThemeProvider>
        <TestToggle />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme-value').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('hub-theme')).toBe('dark');
  });

  it('reads saved theme from localStorage over OS preference', () => {
    localStorage.setItem('hub-theme', 'dark');
    window.matchMedia = (() => ({
      matches: false, // OS says light, but saved says dark
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as any;

    render(
      <ThemeProvider>
        <TestToggle />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme-value').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggles from light to dark on button click', () => {
    window.matchMedia = (() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as any;

    render(
      <ThemeProvider>
        <TestToggle />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByTestId('toggle-btn'));
    expect(screen.getByTestId('theme-value').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(localStorage.getItem('hub-theme')).toBe('dark');
  });

  it('toggles from dark to light on button click', () => {
    localStorage.setItem('hub-theme', 'dark');
    window.matchMedia = (() => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as any;

    render(
      <ThemeProvider>
        <TestToggle />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByTestId('toggle-btn'));
    expect(screen.getByTestId('theme-value').textContent).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('hub-theme')).toBe('light');
  });

  it('applies data-theme attribute matching the current theme', () => {
    window.matchMedia = (() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as any;

    render(
      <ThemeProvider>
        <TestToggle />
      </ThemeProvider>,
    );

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    fireEvent.click(screen.getByTestId('toggle-btn'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('throws when useTheme is used outside ThemeProvider', () => {
    // Suppress console.error for the expected uncaught error
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(<TestToggle />)).toThrow(
      'useTheme must be used within a ThemeProvider',
    );

    spy.mockRestore();
  });
});