/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { ThemeProvider } from '../ThemeContext';
import { ThemeToggle } from '../components/ThemeToggle';

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove('light', 'dark');
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeToggle component', () => {
  it('shows Moon icon and label "Switch to Dark Mode" when theme is light', () => {
    localStorage.setItem('hub-theme', 'light');
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    );
    const btn = screen.getByTestId('theme-toggle');
    expect(btn).toBeDefined();
    expect(btn.getAttribute('title')).toBe('Switch to Dark Mode');
    expect(btn.getAttribute('aria-label')).toBe('Switch to Dark Mode');
  });

  it('shows Sun icon and label "Switch to Light Mode" when theme is dark', () => {
    localStorage.setItem('hub-theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    );
    const btn = screen.getByTestId('theme-toggle');
    expect(btn).toBeDefined();
    expect(btn.getAttribute('title')).toBe('Switch to Light Mode');
    expect(btn.getAttribute('aria-label')).toBe('Switch to Light Mode');
  });

  it('toggles from light to dark on click, updating class/attribute and label', () => {
    localStorage.setItem('hub-theme', 'light');
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    );
    const btn = screen.getByTestId('theme-toggle');
    expect(btn.getAttribute('title')).toBe('Switch to Dark Mode');
    btn.click();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(btn.getAttribute('title')).toBe('Switch to Light Mode');
    expect(btn.getAttribute('aria-label')).toBe('Switch to Light Mode');
  });

  it('toggles from dark to light on click, updating class/attribute and label', () => {
    localStorage.setItem('hub-theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    );
    const btn = screen.getByTestId('theme-toggle');
    expect(btn.getAttribute('title')).toBe('Switch to Light Mode');
    btn.click();
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(btn.getAttribute('title')).toBe('Switch to Dark Mode');
    expect(btn.getAttribute('aria-label')).toBe('Switch to Dark Mode');
  });
});
