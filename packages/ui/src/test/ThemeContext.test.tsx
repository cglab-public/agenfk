/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../ThemeContext';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
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
  });

  afterEach(() => {
    cleanup();
  });

  it('should provide default theme', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    expect(screen.getByText(/Current theme: light/i)).toBeDefined();
  });

  it('should toggle theme', () => {
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    const toggleBtn = screen.getByText('Toggle');
    fireEvent.click(toggleBtn);
    expect(screen.getByText(/Current theme: dark/i)).toBeDefined();
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('should initialize with dark theme from localStorage', () => {
    localStorage.setItem('theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    expect(screen.getByText(/Current theme: dark/i)).toBeDefined();
  });

  it('should provide dark theme when system prefers dark and no localStorage', () => {
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
  });

  it('should toggle from dark back to light', () => {
    localStorage.setItem('theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeTester />
      </ThemeProvider>
    );
    const toggleBtn = screen.getByText('Toggle');
    fireEvent.click(toggleBtn);
    expect(screen.getByText(/Current theme: light/i)).toBeDefined();
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('useTheme should throw when used outside ThemeProvider', () => {
    // Suppress React error boundary console output during test
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ThrowTest = () => {
      useTheme(); // will throw
      return null;
    };
    expect(() => render(<ThrowTest />)).toThrow('useTheme must be used within a ThemeProvider');
    consoleError.mockRestore();
  });
});
