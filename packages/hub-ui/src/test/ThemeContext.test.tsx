/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ThemeProvider, useTheme } from '../ThemeContext';

function matchMediaMock(matches: boolean) {
  return vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function Probe() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme-value">{theme}</span>
      <button onClick={toggleTheme}>toggle</button>
    </div>
  );
}

describe('hub-ui ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.removeAttribute('data-theme');
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: matchMediaMock(false),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('defaults to the light theme when no preference is stored and the OS prefers light', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme-value').textContent).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('defaults to dark when the OS prefers a dark color scheme', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: matchMediaMock(true),
    });
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme-value').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('reads a previously persisted theme from localStorage over the OS preference', () => {
    localStorage.setItem('hub-theme', 'dark');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme-value').textContent).toBe('dark');
  });

  it('toggleTheme flips the theme, updates the <html> class/attribute, and persists to localStorage', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme-value').textContent).toBe('light');

    act(() => { fireEvent.click(screen.getByText('toggle')); });

    expect(screen.getByTestId('theme-value').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('hub-theme')).toBe('dark');

    act(() => { fireEvent.click(screen.getByText('toggle')); });
    expect(screen.getByTestId('theme-value').textContent).toBe('light');
    expect(localStorage.getItem('hub-theme')).toBe('light');
  });

  it('useTheme throws when used outside of a ThemeProvider', () => {
    function Bare() { useTheme(); return null; }
    expect(() => render(<Bare />)).toThrow(/useTheme must be used within a ThemeProvider/);
  });
});
