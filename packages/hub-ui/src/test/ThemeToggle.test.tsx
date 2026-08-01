/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThemeProvider } from '../ThemeContext';
import { ThemeToggle } from '../components/ThemeToggle';

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

function renderInProvider() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>
  );
}

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    root.removeAttribute('data-theme');
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the moon icon in light mode prompting to switch to dark', () => {
    renderInProvider();
    expect(screen.getByTitle('Switch to Dark Mode')).toBeDefined();
    // The moon icon is rendered with an svg; assert via the aria-hidden svg count.
    expect(document.querySelector('svg')).not.toBeNull();
  });

  it('toggles to dark mode on click and updates title/icon', () => {
    renderInProvider();
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(screen.getByTitle('Switch to Light Mode')).toBeDefined();
    expect(window.document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('toggles back to light mode on a second click', () => {
    renderInProvider();
    const button = screen.getByRole('button');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByTitle('Switch to Dark Mode')).toBeDefined();
    expect(window.document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('initializes in dark mode when the persisted theme is dark', () => {
    localStorage.setItem('theme', 'dark');
    renderInProvider();
    expect(screen.getByTitle('Switch to Light Mode')).toBeDefined();
    expect(window.document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
