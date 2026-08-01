/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ThemeProvider } from '../ThemeContext';
import { ThemeToggle } from '../components/ThemeToggle';
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

// ── tests ───────────────────────────────────────────────────────
describe('ThemeToggle', () => {
  const renderToggle = (initialTheme?: string) => {
    if (initialTheme) {
      localStorage.setItem('theme', initialTheme);
    }
    return render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
  };

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation(
      query => defaultMatchMedia(query),
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a <button> with data-testid="theme-toggle"', () => {
    renderToggle();
    const btn = screen.getByTestId('theme-toggle');
    expect(btn.tagName).toBe('BUTTON');
  });

  it('aria-label names the target theme (switches to dark) when current theme is light', () => {
    renderToggle();
    const btn = screen.getByTestId('theme-toggle');
    expect(btn.getAttribute('aria-label')).toMatch(/dark/i);
  });

  it('aria-label names the target theme (switches to light) when current theme is dark', () => {
    renderToggle('dark');
    const btn = screen.getByTestId('theme-toggle');
    expect(btn.getAttribute('aria-label')).toMatch(/light/i);
  });

  it('aria-pressed is "false" when theme is light', () => {
    renderToggle();
    const btn = screen.getByTestId('theme-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('aria-pressed is "true" when theme is dark', () => {
    renderToggle('dark');
    const btn = screen.getByTestId('theme-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('clicking the button toggles light → dark and updates DOM + localStorage', () => {
    renderToggle();
    const btn = screen.getByTestId('theme-toggle');
    fireEvent.click(btn);

    const root = document.documentElement;
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.classList.contains('light')).toBe(false);
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('clicking the button again toggles dark → light and updates DOM + localStorage', () => {
    renderToggle();
    const btn = screen.getByTestId('theme-toggle');

    // light → dark
    fireEvent.click(btn);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('theme')).toBe('dark');

    // dark → light
    fireEvent.click(btn);
    const root = document.documentElement;
    expect(root.classList.contains('light')).toBe(true);
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('aria-label updates after click to reflect the new target theme', () => {
    renderToggle();
    const btn = screen.getByTestId('theme-toggle');

    // Initially in light mode — label mentions dark
    expect(btn.getAttribute('aria-label')).toMatch(/dark/i);

    fireEvent.click(btn);
    // Now in dark mode — label should mention light
    expect(btn.getAttribute('aria-label')).toMatch(/light/i);
  });
});